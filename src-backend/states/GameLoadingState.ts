/**
 * 游戏加载状态
 * @module GameLoadingState
 * @description 等待游戏加载完成的状态。
 *
 * 恢复机制（解决"没有正常进入游戏，需要手动重连"）：
 * 1. 继续通过 InGame API (localhost:2999) 轮询判断游戏是否真正可访问
 * 2. 同时每 1.5 秒通过 LCU REST 查询真实 gameflow 阶段作为兜底
 * 3. 检测到 Reconnect / FailedToLaunch 异常阶段 → 自动重连
 * 4. 阶段为 InProgress 但 InGame API 持续 15 秒不可访问 → 判定加载异常并重连
 * 5. 重连约 5 秒一次，最多 3 次；多次失败后 killGameProcess + reconnect 兜底
 * 6. 整个状态设置硬超时，禁止无限等待
 */

import { IState } from "./IState";
import { logger } from "../utils/Logger.ts";
import { EndState } from "./EndState.ts";
import { GameRunningState } from "./GameRunningState.ts";
import { LobbyState } from "./LobbyState.ts";
import { InGameApiEndpoints } from "../lcu/InGameApi.ts";
import { GAME_WIDTH, GAME_HEIGHT } from "../tft/types.ts";
import { getDefaultStateDeps } from "./DefaultStateDeps.ts";
import type { StateDeps } from "./StateDeps.ts";
import { GameflowRecovery } from "../services/GameflowRecovery.ts";

/** InGame API 轮询间隔 (ms) */
const POLL_INTERVAL_MS = 500;

/** gameflow REST 兜底轮询间隔 (ms) */
const GAMEFLOW_POLL_INTERVAL_MS = 1500;

/** InProgress 但 InGame API 持续不可访问的判定阈值 (ms) */
const INGAME_STUCK_THRESHOLD_MS = 15000;

/** 整个加载状态的硬超时 (ms)，防止无限等待 */
const GAME_LOADING_HARD_TIMEOUT_MS = 3 * 60 * 1000;

/** 自动重连的最大次数 */
const MAX_RECONNECT_ATTEMPTS = 3;

/** 自动重连重试间隔 (ms) */
const RECONNECT_INTERVAL_MS = 5000;

/** 加载等待结果 */
export type GameLoadResult = "loaded" | "interrupted" | "timeout";

/**
 * 游戏加载状态类
 * @description 开局后等待游戏加载完成，轮询检测游戏是否已启动
 */
export class GameLoadingState implements IState {
    /** 状态名称 */
    public readonly name = "GameLoadingState";

    /** 依赖集合（可注入，便于测试） */
    private readonly deps: StateDeps;

    constructor(deps?: StateDeps) {
        this.deps = deps ?? getDefaultStateDeps();
    }

    /**
     * 执行游戏加载状态逻辑
     * @param signal AbortSignal 用于取消等待
     * @returns 下一个状态 (GameRunningState / LobbyState / EndState)
     */
    async action(signal: AbortSignal): Promise<IState> {
        signal.throwIfAborted();
        logger.info("[GameLoadingState] 等待进入对局...");

        const recovery = new GameflowRecovery({
            lcu: this.deps.lcu,
            logger,
            maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
            reconnectIntervalMs: RECONNECT_INTERVAL_MS,
        });

        const result = await this.waitForGameToLoad(signal, recovery);

        if (result === "loaded") {
            logger.info("[GameLoadingState] 对局已开始！");
            recovery.resetAttempts();
            await this.initOperator();
            return new GameRunningState();
        }

        if (signal.aborted || result === "interrupted") {
            logger.info("[GameLoadingState] 加载被中断");
            return new EndState();
        }

        // 硬超时：做最后一次恢复尝试，然后明确重置流程（回到大厅重新排队）
        logger.warn("[GameLoadingState] 加载硬超时，执行最终恢复尝试...");
        await recovery.reconnectWithRetries("加载硬超时", signal);
        logger.warn("[GameLoadingState] 恢复尝试结束，回到大厅重新开始流程");
        return new LobbyState();
    }

    /**
     * 初始化 TftOperator（查找游戏窗口位置并校验分辨率）
     */
    private async initOperator(): Promise<void> {
        try {
            const initResult = await this.deps.tftOperator.init();

            if (!initResult.success) {
                logger.error("[GameLoadingState] TftOperator 初始化失败!");
                return;
            }

            if (initResult.windowInfo) {
                const { width, height } = initResult.windowInfo;
                if (width !== GAME_WIDTH || height !== GAME_HEIGHT) {
                    logger.error(
                        `[GameLoadingState] ❌ 游戏分辨率不正确！` +
                        `当前: ${width}x${height}, 需要: ${GAME_WIDTH}x${GAME_HEIGHT}。` +
                        `请在游戏设置中将分辨率修改为 ${GAME_WIDTH}x${GAME_HEIGHT}！`
                    );
                }
            }
        } catch (error) {
            logger.warn(`[GameLoadingState] TftOperator 初始化异常: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * 等待游戏加载完成
     * @param signal AbortSignal 用于取消轮询
     * @param recovery 恢复助手
     * @returns 加载结果
     */
    private waitForGameToLoad(signal: AbortSignal, recovery: GameflowRecovery): Promise<GameLoadResult> {
        return new Promise((resolve) => {
            let inGameTimer: NodeJS.Timeout | null = null;
            let gameflowTimer: NodeJS.Timeout | null = null;
            let hardTimeoutTimer: NodeJS.Timeout | null = null;

            let isResolved = false;
            let isGameflowChecking = false;
            /** 是否正在执行重连恢复序列（避免并发重复触发） */
            let isRecovering = false;
            /** InGame API 当前是否可用 */
            let isInGameAvailable = false;
            /** 首次检测到 InProgress 但 InGame API 不可用的时间戳 */
            let firstInProgressWithoutApiAt: number | null = null;

            /**
             * 清理所有定时器和监听
             */
            const cleanup = () => {
                if (inGameTimer) {
                    clearInterval(inGameTimer);
                    inGameTimer = null;
                }
                if (gameflowTimer) {
                    clearInterval(gameflowTimer);
                    gameflowTimer = null;
                }
                if (hardTimeoutTimer) {
                    clearTimeout(hardTimeoutTimer);
                    hardTimeoutTimer = null;
                }
                signal.removeEventListener("abort", onAbort);
            };

            /**
             * 安全的 resolve，防止重复调用
             */
            const safeResolve = (value: GameLoadResult) => {
                if (isResolved) return;
                isResolved = true;
                cleanup();
                resolve(value);
            };

            /**
             * 处理 abort 事件
             */
            const onAbort = () => {
                logger.info("[GameLoadingState] 收到取消信号，停止轮询");
                safeResolve("interrupted");
            };

            /**
             * 执行重连恢复序列（同一时间只允许一个）
             */
            const runRecovery = async (reason: string) => {
                if (isRecovering || isResolved) return;
                isRecovering = true;
                firstInProgressWithoutApiAt = null;
                try {
                    await recovery.reconnectWithRetries(reason, signal);
                } catch (error) {
                    logger.warn(`[GameLoadingState] 自动重连异常: ${error instanceof Error ? error.message : String(error)}`);
                } finally {
                    isRecovering = false;
                }
            };

            /**
             * InGame API 轮询：请求成功即认为游戏已加载
             */
            const checkInGameApi = async () => {
                if (isResolved) return;
                try {
                    await this.deps.inGameApi.get(InGameApiEndpoints.ALL_GAME_DATA);
                    isInGameAvailable = true;
                    logger.info("[GameLoadingState] 检测到 InGame API 可用，对局已开始");
                    safeResolve("loaded");
                } catch {
                    isInGameAvailable = false;
                    logger.debug("[GameLoadingState] 游戏仍在加载中...");
                }
            };

            /**
             * gameflow REST 兜底轮询：处理 WebSocket 丢事件 / 异常阶段
             */
            const checkGameflow = async () => {
                if (isResolved || isInGameAvailable || isGameflowChecking) return;
                isGameflowChecking = true;
                try {
                    const phase = await recovery.readPhase();
                    if (isResolved) return;

                    // 1. 异常阶段（Reconnect / FailedToLaunch）→ 自动重连
                    if (GameflowRecovery.isAbnormalPhase(phase)) {
                        logger.info(`[GameLoadingState] 检测到异常 gameflow 阶段: ${phase}`);
                        void runRecovery(String(phase));
                        return;
                    }

                    // 2. InProgress 但 InGame API 持续不可用 → 判定加载异常
                    if (phase === "InProgress") {
                        if (firstInProgressWithoutApiAt === null) {
                            firstInProgressWithoutApiAt = Date.now();
                            logger.info("[GameLoadingState] 检测到 InProgress，但 InGame API 尚不可用，开始计时");
                        } else if (
                            !isRecovering &&
                            Date.now() - firstInProgressWithoutApiAt >= INGAME_STUCK_THRESHOLD_MS
                        ) {
                            logger.warn(
                                `[GameLoadingState] InGame API 持续 ${INGAME_STUCK_THRESHOLD_MS / 1000} 秒不可访问，判定加载异常`
                            );
                            void runRecovery("InProgress 但 InGame API 不可用");
                        }
                    } else {
                        // 其他阶段重置计时
                        firstInProgressWithoutApiAt = null;
                    }
                } finally {
                    isGameflowChecking = false;
                }
            };

            signal.addEventListener("abort", onAbort, { once: true });

            // 启动 InGame API 轮询
            inGameTimer = setInterval(checkInGameApi, POLL_INTERVAL_MS);
            // 启动 gameflow REST 兜底轮询
            gameflowTimer = setInterval(checkGameflow, GAMEFLOW_POLL_INTERVAL_MS);
            // 启动硬超时
            hardTimeoutTimer = setTimeout(() => {
                logger.warn(`[GameLoadingState] 加载硬超时（${GAME_LOADING_HARD_TIMEOUT_MS / 1000}秒）`);
                safeResolve("timeout");
            }, GAME_LOADING_HARD_TIMEOUT_MS);

            // 立即各执行一次
            void checkInGameApi();
            void checkGameflow();
        });
    }
}
