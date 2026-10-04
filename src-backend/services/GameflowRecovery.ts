/**
 * 游戏流程恢复助手
 * @module GameflowRecovery
 * @description 统一封装"对局异常恢复"相关的操作，供各个状态复用：
 *              - 通过 REST 查询真实 gameflow 阶段（WebSocket 丢事件时的兜底）
 *              - 自动重连（防重复调用 + 冷却时间 + 有限次重试 + 最终 kill 兜底）
 *              - 自动跳过对局结算页面（防重复调用）
 *
 * 设计目的：
 * 1. 把"重连/跳过结算"的防重复控制集中到一个地方，避免 WebSocket 和 REST 同时检测到同一状态后重复调用接口
 * 2. 纯依赖注入（LCU、日志、时钟），不直接依赖 Electron / 原生模块，方便单元测试
 *
 * 关键字段（对应需求中的防重复控制）：
 * - reconnectInProgress：重连请求是否正在进行
 * - lastReconnectTime：上次重连请求时间（冷却窗口，避免重复调用）
 * - reconnectAttempts：本轮自动重连已尝试次数
 * - dismissInProgress：跳过结算请求是否正在进行
 */

import { sleep } from "../utils/HelperTools";
import {
    GameFlowPhase,
    isAbnormalGameflowPhase,
    isEndOfGamePhase,
    isLobbyGameflowPhase,
} from "../lcu/utils/LCUProtocols";

/** 恢复助手依赖的 LCU 能力子集 */
export interface RecoveryLcuLike {
    /** 查询当前 gameflow 阶段（REST 兜底） */
    getGameflowPhase(): Promise<GameFlowPhase | undefined>;
    /** 请求重新连接对局 */
    reconnectGame(): Promise<any>;
    /** 跳过对局结束结算页面 */
    dismissEndOfGameStats(): Promise<any>;
    /** 强制杀掉游戏进程（最终兜底） */
    killGameProcess(): Promise<boolean>;
}

/** 恢复助手依赖的日志能力子集（与 utils/Logger 兼容） */
export interface RecoveryLoggerLike {
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}

/** 恢复助手依赖的时钟能力（便于测试替换） */
export interface RecoveryClock {
    now(): number;
    sleep(ms: number): Promise<void>;
}

export interface GameflowRecoveryOptions {
    /** LCU 客户端（未连接时为 null） */
    lcu: RecoveryLcuLike | null;
    /** 日志器 */
    logger: RecoveryLoggerLike;
    /** 可选时钟，默认使用 Date.now + sleep */
    clock?: RecoveryClock;
    /** 两次重连请求之间的最小冷却时间 (ms)，用于合并 WS 和 REST 的重复触发 */
    reconnectCooldownMs?: number;
    /** 重试之间的等待时间 (ms) */
    reconnectIntervalMs?: number;
    /** 最大自动重连次数 */
    maxReconnectAttempts?: number;
    /** 跳过结算请求的最小冷却时间 (ms) */
    dismissCooldownMs?: number;
}

/** 默认冷却时间 (ms)：合并 WS 与 REST 的重复触发 */
export const DEFAULT_RECONNECT_COOLDOWN_MS = 2000;

/** 默认重连重试间隔 (ms)：约 5 秒一次 */
export const DEFAULT_RECONNECT_INTERVAL_MS = 5000;

/** 默认最大重连次数 */
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 3;

/** 默认跳过结算冷却时间 (ms) */
export const DEFAULT_DISMISS_COOLDOWN_MS = 2000;

/** 取错误信息的辅助函数 */
function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

/**
 * 游戏流程恢复助手
 */
export class GameflowRecovery {
    private readonly lcu: RecoveryLcuLike | null;
    private readonly logger: RecoveryLoggerLike;
    private readonly clock: RecoveryClock;
    private readonly reconnectCooldownMs: number;
    private readonly reconnectIntervalMs: number;
    private readonly maxReconnectAttempts: number;
    private readonly dismissCooldownMs: number;

    /** 重连是否正在进行（防重复） */
    private reconnectInProgress = false;
    /** 上次重连时间（冷却窗口），初始为负无穷保证首次调用不被冷却拦截 */
    private lastReconnectTime = Number.NEGATIVE_INFINITY;
    /** 本轮自动重连已尝试次数 */
    private reconnectAttempts = 0;
    /** 跳过结算是否正在进行（防重复） */
    private dismissInProgress = false;
    /** 上次跳过结算时间（冷却窗口），初始为负无穷保证首次调用不被冷却拦截 */
    private lastDismissTime = Number.NEGATIVE_INFINITY;

    constructor(options: GameflowRecoveryOptions) {
        this.lcu = options.lcu;
        this.logger = options.logger;
        this.clock = options.clock ?? { now: () => Date.now(), sleep };
        this.reconnectCooldownMs = options.reconnectCooldownMs ?? DEFAULT_RECONNECT_COOLDOWN_MS;
        this.reconnectIntervalMs = options.reconnectIntervalMs ?? DEFAULT_RECONNECT_INTERVAL_MS;
        this.maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
        this.dismissCooldownMs = options.dismissCooldownMs ?? DEFAULT_DISMISS_COOLDOWN_MS;
    }

    /** 当前已尝试的重连次数 */
    public get attempts(): number {
        return this.reconnectAttempts;
    }

    /** 重置重连次数（例如检测到已经成功进入对局时调用） */
    public resetAttempts(): void {
        this.reconnectAttempts = 0;
    }

    /** 判断阶段是否需要异常恢复 */
    public static isAbnormalPhase(phase: GameFlowPhase | undefined | null): boolean {
        return isAbnormalGameflowPhase(phase);
    }

    /** 判断阶段是否表示对局已结束 */
    public static isEndPhase(phase: GameFlowPhase | undefined | null): boolean {
        return isEndOfGamePhase(phase);
    }

    /** 判断阶段是否表示已回到大厅 */
    public static isLobbyPhase(phase: GameFlowPhase | undefined | null): boolean {
        return isLobbyGameflowPhase(phase);
    }

    /**
     * 通过 REST 查询当前真实 gameflow 阶段（失败时返回 undefined，不抛出）
     */
    public async readPhase(): Promise<GameFlowPhase | undefined> {
        if (!this.lcu) return undefined;
        try {
            return await this.lcu.getGameflowPhase();
        } catch (error) {
            this.logger.debug(`[GameflowRecovery] 查询 gameflow 阶段失败（将重试）: ${errorMessage(error)}`);
            return undefined;
        }
    }

    /**
     * 单次自动重连请求（带防重复 + 冷却）
     * @param reason 触发原因，用于日志
     * @param force 是否忽略冷却窗口（重试流程中强制发起）
     * @returns true 表示重连请求发送成功
     */
    public async reconnect(reason: string = "异常状态", force: boolean = false): Promise<boolean> {
        if (!this.lcu) {
            this.logger.warn(`[GameflowRecovery] 检测到 ${reason}，但 LCU 未连接，无法重连`);
            return false;
        }

        if (this.reconnectInProgress) {
            this.logger.info("[GameflowRecovery] 重连已在进行中，跳过重复调用");
            return false;
        }

        const now = this.clock.now();
        if (!force && now - this.lastReconnectTime < this.reconnectCooldownMs) {
            this.logger.debug("[GameflowRecovery] 距上次重连时间过短，跳过本次重复重连");
            return false;
        }

        this.reconnectInProgress = true;
        try {
            await this.lcu.reconnectGame();
            this.lastReconnectTime = this.clock.now();
            this.logger.info(`[GameflowRecovery] 检测到 ${reason}，重连请求已发送`);
            return true;
        } catch (error) {
            this.lastReconnectTime = this.clock.now();
            this.logger.warn(`[GameflowRecovery] 重连请求失败: ${errorMessage(error)}`);
            return false;
        } finally {
            this.reconnectInProgress = false;
        }
    }

    /**
     * 有限次自动重连，失败后执行 killGameProcess + reconnect 作为最终兜底
     * @param reason 触发原因，用于日志
     * @param signal AbortSignal，用于用户停止时提前退出
     * @returns true 表示某一轮重连请求发送成功
     */
    public async reconnectWithRetries(reason: string = "异常状态", signal?: AbortSignal): Promise<boolean> {
        this.reconnectAttempts = 0;
        const max = this.maxReconnectAttempts;

        for (let attempt = 1; attempt <= max; attempt++) {
            if (signal?.aborted) {
                this.logger.info("[GameflowRecovery] 收到取消信号，停止自动重连");
                return false;
            }

            this.reconnectAttempts = attempt;
            this.logger.info(`[GameflowRecovery] 第 ${attempt}/${max} 次自动重连（原因: ${reason}）`);
            const ok = await this.reconnect(reason, true);
            if (ok) {
                this.logger.info("[GameflowRecovery] 重连成功");
                return true;
            }

            if (attempt < max) {
                await this.clock.sleep(this.reconnectIntervalMs);
            }
        }

        // 多次失败后的最终兜底：杀掉游戏进程再重连
        this.logger.warn("[GameflowRecovery] 多次自动重连失败，执行最终兜底：杀掉游戏进程并重连");
        try {
            await this.lcu?.killGameProcess();
            this.logger.info("[GameflowRecovery] 游戏进程已杀掉，准备最终重连");
        } catch (error) {
            this.logger.warn(`[GameflowRecovery] 杀掉游戏进程失败: ${errorMessage(error)}`);
        }

        await this.clock.sleep(1000);
        const ok = await this.reconnect(`${reason}（最终兜底）`, true);
        if (ok) {
            this.logger.info("[GameflowRecovery] 最终兜底重连请求已发送");
        } else {
            this.logger.error("[GameflowRecovery] 最终兜底重连仍失败，需要重新开始流程");
        }
        return ok;
    }

    /**
     * 跳过对局结算页面（带防重复 + 冷却）
     * @param reason 触发原因，用于日志
     * @returns true 表示跳过请求发送成功
     */
    public async dismissStats(reason: string = "对局结束"): Promise<boolean> {
        if (!this.lcu) return false;

        if (this.dismissInProgress) {
            this.logger.debug("[GameflowRecovery] 跳过结算已在进行中，跳过重复调用");
            return false;
        }

        const now = this.clock.now();
        if (now - this.lastDismissTime < this.dismissCooldownMs) {
            this.logger.debug("[GameflowRecovery] 距上次跳过结算时间过短，跳过本次重复调用");
            return false;
        }

        this.dismissInProgress = true;
        try {
            await this.lcu.dismissEndOfGameStats();
            this.lastDismissTime = this.clock.now();
            this.logger.info(`[GameflowRecovery] 检测到 ${reason}，正在自动跳过结算`);
            return true;
        } catch (error) {
            this.lastDismissTime = this.clock.now();
            this.logger.warn(`[GameflowRecovery] 跳过结算请求失败: ${errorMessage(error)}`);
            return false;
        } finally {
            this.dismissInProgress = false;
        }
    }
}
