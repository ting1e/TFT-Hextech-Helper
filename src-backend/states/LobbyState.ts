/**
 * 大厅状态
 * @module LobbyState
 * @description 客户端已启动，创建房间、选择模式、排队匹配。
 *
 * 恢复机制（解决"已经匹配成功但状态事件丢失"）：
 * 1. 继续监听 WebSocket 的 ReadyCheck 和 GAMEFLOW_PHASE
 * 2. 增加 REST gameflow 轮询作为兜底
 * 3. 接受对局后不彻底取消所有超时，而是切换为 gameLaunchTimeout (75 秒)
 * 4. 超时后主动查询真实状态：
 *    - InProgress     → 进入 GameLoadingState
 *    - Reconnect      → 自动重连
 *    - FailedToLaunch → 自动恢复
 *    - 已返回大厅      → 重新排队
 * 5. 避免 WebSocket 少一条事件后永久卡在 LobbyState
 */

import { IState } from "./IState";
import { LcuEventUri, LCUWebSocketMessage } from "../lcu/LCUManager.ts";
import { Queue, GameFlowPhase } from "../lcu/utils/LCUProtocols.ts";
import { sleep } from "../utils/HelperTools.ts";
import { logger } from "../utils/Logger.ts";
import { GameLoadingState } from "./GameLoadingState.ts";
import { EndState } from "./EndState.ts";
import { StartState } from "./StartState.ts";
import { TFTMode } from "../TFTProtocol.ts";
import { getDefaultStateDeps } from "./DefaultStateDeps.ts";
import type { StateDeps } from "./StateDeps.ts";
import { GameflowRecovery } from "../services/GameflowRecovery.ts";

/** 创建房间后的等待时间 (ms) */
const LOBBY_CREATE_DELAY_MS = 500;

/** 流程中断后重试前的等待时间 (ms) */
const RETRY_DELAY_MS = 1000;

/** abort 信号轮询间隔 (ms)，作为事件监听的兜底 */
const ABORT_CHECK_INTERVAL_MS = 500;

/** 创建房间的最大重试次数 */
const MAX_CREATE_LOBBY_RETRIES = 3;

/** 创建房间重试间隔 (ms) */
const CREATE_LOBBY_RETRY_DELAY_MS = 1000;

/** 开始匹配的最大重试次数 */
const MAX_START_MATCH_RETRIES = 5;

/** 开始匹配重试间隔 (ms) */
const START_MATCH_RETRY_DELAY_MS = 500;

/** 发条鸟模式排队超时时间 (ms) - 超过此时间未进入游戏则退出房间重试 */
const CLOCKWORK_MATCH_TIMEOUT_MS = 3000;

/** 退出房间重试间隔 (ms) - 每秒重试一次，用于收集限频 CD 数据 */
const LEAVE_LOBBY_RETRY_DELAY_MS = 1000;

/** 接受对局后的 gameflow REST 兜底轮询间隔 (ms) */
const GAMEFLOW_POLL_INTERVAL_MS = 1500;

/** 接受对局后等待游戏真正启动的超时时间 (ms)，60~90 秒之间 */
const GAME_LAUNCH_TIMEOUT_MS = 75000;

/** 自动重连的最大次数 */
const MAX_RECONNECT_ATTEMPTS = 3;

/** 自动重连重试间隔 (ms) */
const RECONNECT_INTERVAL_MS = 5000;

/** 等待游戏开始的返回值 */
export type LobbyWaitResult =
    | "started"
    | "timeout"
    | "interrupted"
    | "error"
    | "requeue";

/**
 * 大厅状态类
 * @description 负责创建房间、开始匹配、等待游戏开始
 */
export class LobbyState implements IState {
    /** 状态名称 */
    public readonly name = "LobbyState";

    /** 依赖集合（可注入，便于测试） */
    private readonly deps: StateDeps;

    constructor(deps?: StateDeps) {
        this.deps = deps ?? getDefaultStateDeps();
    }

    /**
     * 根据用户设置获取对应的队列 ID
     * @returns TFT 队列 ID（匹配、排位、发条鸟或回归赛季）
     */
    private getQueueId(): Queue {
        const tftMode = this.deps.settings.get('tftMode');

        switch (tftMode) {
            case TFTMode.RANK:
                logger.info("[LobbyState] 当前模式: 主赛季排位赛");
                return Queue.TFT_RANKED;
            case TFTMode.CLOCKWORK_TRAILS:
                logger.info("[LobbyState] 当前模式: 发条鸟的试炼");
                return Queue.TFT_FATIAO; // 发条鸟队列ID = 1220
            case TFTMode.S4_RUISHOU:
                logger.info("[LobbyState] 当前模式: S4 瑞兽闹新春");
                return Queue.TFT_SET_REVIVAL; // 回归赛季队列ID = 6110
            case TFTMode.S17_XINGSHEN:
                logger.info("[LobbyState] 当前模式: S17 星神 匹配");
                return Queue.TFT_SET_REVIVAL; // 回归赛季队列ID = 6110
            case TFTMode.NORMAL:
            default:
                logger.info("[LobbyState] 当前模式: 主赛季匹配模式");
                return Queue.TFT_NORMAL;
        }
    }

    /**
     * 执行大厅状态逻辑
     * @param signal AbortSignal 用于取消操作
     * @returns 下一个状态
     */
    async action(signal: AbortSignal): Promise<IState> {
        signal.throwIfAborted();

        if (!this.deps.lcu) {
            throw Error("[LobbyState] 检测到客户端未启动！");
        }

        // 获取用户选择的游戏模式
        const queueId = this.getQueueId();
        const tftMode = this.deps.settings.get('tftMode');
        const isClockworkMode = tftMode === TFTMode.CLOCKWORK_TRAILS;

        // 创建房间（带重试机制）
        const lobbyCreated = await this.createLobbyWithRetry(queueId, signal);
        if (!lobbyCreated) {
            // 重试都失败了，返回 StartState 重新开始
            logger.error("[LobbyState] 创建房间失败，已达到最大重试次数，重新开始");
            return this;
        }
        await sleep(LOBBY_CREATE_DELAY_MS);

        // ── 排队随机间隔：如果用户开启了该功能，在排队前等待随机秒数 ──
        const delayConfig = this.deps.settings.get('queueRandomDelay');
        if (delayConfig?.enabled && delayConfig.maxSeconds > 0) {
            // 在 [minSeconds, maxSeconds] 范围内取一个随机整数
            const min = Math.max(0, Math.floor(delayConfig.minSeconds));
            const max = Math.max(min, Math.floor(delayConfig.maxSeconds));
            const randomSeconds = min + Math.floor(Math.random() * (max - min + 1));
            if (randomSeconds > 0) {
                logger.info(`[LobbyState] 排队随机间隔：等待 ${randomSeconds} 秒后开始排队...`);
                await sleep(randomSeconds * 1000);
                // 等待期间可能被取消，检查一下
                signal.throwIfAborted();
            }
        }

        // 开始排队（带重试机制）
        const matchStarted = await this.startMatchWithRetry(signal);
        if (!matchStarted) {
            // 重试都失败了，返回 EndState 结束流程
            logger.warn("[LobbyState] 开始匹配失败，已达到最大重试次数，尝试退出房间");
            await this.leaveLobbyWithRetry(signal)

            logger.error("[LobbyState] 退出房间成功，重启LobbyState");
            return this;
        }

        // ── 计算排队超时时间 ──
        // 发条鸟模式：硬编码 3 秒超时
        // 普通模式：读取用户配置的超时分钟数（0 = 不超时）
        let timeoutMs = 0;
        if (isClockworkMode) {
            timeoutMs = CLOCKWORK_MATCH_TIMEOUT_MS;
        } else {
            const timeoutConfig = this.deps.settings.get('queueTimeout');
            if (timeoutConfig?.enabled && timeoutConfig.minutes > 0) {
                timeoutMs = timeoutConfig.minutes * 60 * 1000;
                logger.info(`[LobbyState] 排队超时已开启：${timeoutConfig.minutes} 分钟后将自动退出重排`);
            }
        }

        // 等待游戏开始（支持超时机制 + REST 兜底恢复）
        const waitResult = await this.waitForGameToStart(signal, timeoutMs);

        if (waitResult === 'started') {
            logger.info("[LobbyState] 游戏已开始！流转到 GameLoadingState");
            return new GameLoadingState();
        } else if (waitResult === 'timeout') {
            // 排队超时（尚未接受对局），退出房间（带重试机制），回到 StartState 重新开始
            logger.warn("[LobbyState] 排队超时，退出房间重新开始...");
            const leaveSuccess = await this.leaveLobbyWithRetry(signal);
            if (!leaveSuccess) {
                logger.error("[LobbyState] 退出房间失败，已达到最大重试次数，流程结束");
                return new EndState();
            }
            return new StartState();
        } else if (waitResult === 'error') {
            logger.warn("[LobbyState] 游戏阶段异常 (TerminatedInError)，重新开始 LobbyState");
            return this;
        } else if (waitResult === 'requeue') {
            // 接受后长时间未进入游戏/已返回大厅/流程中断（如秒退），重新排队
            logger.warn("[LobbyState] 流程中断或已返回大厅，将重新排队...");
            await sleep(RETRY_DELAY_MS);
            return this;
        } else {
            // 用户主动停止 (interrupted)
            return new EndState();
        }
    }

    /**
     * 创建房间（带重试机制）
     * @param queueId 队列 ID
     * @param signal AbortSignal 用于取消操作
     * @returns true 表示成功创建房间，false 表示重试都失败了
     */
    private async createLobbyWithRetry(queueId: Queue, signal: AbortSignal): Promise<boolean> {
        for (let attempt = 1; attempt <= MAX_CREATE_LOBBY_RETRIES; attempt++) {
            // 检查是否已取消
            if (signal.aborted) {
                logger.info("[LobbyState] 收到取消信号，停止创建房间重试");
                return false;
            }

            try {
                logger.info(`[LobbyState] 正在创建房间... (第 ${attempt} 次尝试)`);
                await this.deps.lcu!.createLobbyByQueueId(queueId);
                logger.info("[LobbyState] 创建房间成功！");
                return true;
            } catch (e: any) {
                const errorMsg = e.message || '';

                logger.warn(`[LobbyState] 创建房间失败 (第 ${attempt} 次): ${errorMsg}`);

                // 如果还有重试机会，等待一段时间后重试
                if (attempt < MAX_CREATE_LOBBY_RETRIES) {
                    logger.info(`[LobbyState] ${CREATE_LOBBY_RETRY_DELAY_MS}ms 后重试...`);
                    await sleep(CREATE_LOBBY_RETRY_DELAY_MS);
                }
            }
        }

        return false;
    }

    /**
     * 开始匹配（带重试机制）
     * @param signal AbortSignal 用于取消操作
     * @returns true 表示成功开始匹配，false 表示重试都失败了
     */
    private async startMatchWithRetry(signal: AbortSignal): Promise<boolean> {
        for (let attempt = 1; attempt <= MAX_START_MATCH_RETRIES; attempt++) {
            // 检查是否已取消
            if (signal.aborted) {
                logger.info("[LobbyState] 收到取消信号，停止匹配重试");
                return false;
            }

            try {
                logger.info(`[LobbyState] 正在开始排队...`);
                await this.deps.lcu!.startMatch();
                logger.info("[LobbyState] 排队成功！");
                return true;
            } catch (e: any) {
                const errorMsg = e.message || '';
                // 404 表示已经进入对局，视为排队成功
                if (errorMsg.includes('404')) {
                    logger.info(`[LobbyState] 房间已不存在 (404)，视为排队成功！共尝试 ${attempt} 次`);
                    return true;
                }

                // 423 Locked 表示已进入对局，房间被锁定，视为正常（已经进游戏了）
                if (errorMsg.includes('423')) {
                    logger.info(`[LobbyState] 房间已锁定 (423)，已进入对局，视为正常！共尝试 ${attempt} 次`);
                    return true;
                }

                logger.warn(`[LobbyState] 开始匹配失败 (第 ${attempt} 次): ${e.message}`);

                // 如果还有重试机会，等待一段时间后重试
                if (attempt < MAX_START_MATCH_RETRIES) {
                    logger.info(`[LobbyState] ${START_MATCH_RETRY_DELAY_MS}ms 后重试...`);
                    await sleep(START_MATCH_RETRY_DELAY_MS);
                }
            }
        }

        return false;
    }

    /**
     * 退出房间（无限重试，每秒一次，直到成功）
     * @param signal AbortSignal 用于取消操作
     * @returns true 表示成功退出房间，false 表示被取消
     */
    private async leaveLobbyWithRetry(signal: AbortSignal): Promise<boolean> {
        let attempt = 0;

        while (true) {
            attempt++;

            // 检查是否已取消
            if (signal.aborted) {
                logger.info("[LobbyState] 收到取消信号，停止退出房间重试");
                return false;
            }

            try {
                logger.info(`[LobbyState] 正在退出房间... (第 ${attempt} 次尝试)`);
                await this.deps.lcu!.leaveLobby();
                await sleep(100);  // 等待房间退出完成
                logger.info(`[LobbyState] 成功退出房间！共尝试 ${attempt} 次`);
                return true;
            } catch (e: any) {
                const errorMsg = e.message || '';

                // 404 表示房间已不存在，视为退出成功
                if (errorMsg.includes('404')) {
                    logger.info(`[LobbyState] 房间已不存在 (404)，视为退出成功！共尝试 ${attempt} 次`);
                    return true;
                }

                // 423 Locked 表示已进入对局，房间被锁定，视为正常（已经进游戏了）
                if (errorMsg.includes('423')) {
                    logger.info(`[LobbyState] 房间已锁定 (423)，已进入对局，视为正常！共尝试 ${attempt} 次`);
                    return true;
                }

                logger.warn(`[LobbyState] 退出房间失败 (第 ${attempt} 次): ${errorMsg}`);
                // 等待 1 秒后重试
                await sleep(LEAVE_LOBBY_RETRY_DELAY_MS);
            }
        }
    }

    /**
     * 等待从"排队"到"游戏开始"的完整流程
     * @param signal AbortSignal 用于取消等待
     * @param timeoutMs 排队超时毫秒数，0 表示不超时（仅针对尚未接受对局的阶段）
     * @returns 'started' 游戏成功开始；'timeout' 排队超时；'interrupted' 用户停止；'error' 异常；'requeue' 需要重新排队
     */
    private waitForGameToStart(signal: AbortSignal, timeoutMs: number = 0): Promise<LobbyWaitResult> {
        return new Promise((resolve) => {
            const recovery = new GameflowRecovery({
                lcu: this.deps.lcu,
                logger,
                maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
                reconnectIntervalMs: RECONNECT_INTERVAL_MS,
            });

            let stopCheckInterval: NodeJS.Timeout | null = null;
            let queueTimeoutTimer: NodeJS.Timeout | null = null;
            let gameLaunchTimer: NodeJS.Timeout | null = null;
            let gameflowPollTimer: NodeJS.Timeout | null = null;
            let isResolved = false;
            let lastAcceptTime = 0;  // 上次接受对局的时间戳，用于节流
            /** 是否已经接受过对局 */
            let hasAccepted = false;
            /** 是否正在执行重连恢复序列 */
            let isRecovering = false;
            /** gameflow REST 查询是否正在进行 */
            let isGameflowChecking = false;

            /**
             * 安全的 resolve，防止重复调用
             */
            const safeResolve = (value: LobbyWaitResult) => {
                if (isResolved) return;
                isResolved = true;
                cleanup();
                resolve(value);
            };

            /**
             * 清理所有监听器和定时器
             */
            const cleanup = () => {
                this.deps.lcu?.off(LcuEventUri.READY_CHECK, onReadyCheck);
                this.deps.lcu?.off(LcuEventUri.GAMEFLOW_PHASE, onGameflowPhase);
                signal.removeEventListener("abort", onAbort);
                if (stopCheckInterval) {
                    clearInterval(stopCheckInterval);
                    stopCheckInterval = null;
                }
                if (queueTimeoutTimer) {
                    clearTimeout(queueTimeoutTimer);
                    queueTimeoutTimer = null;
                }
                if (gameLaunchTimer) {
                    clearTimeout(gameLaunchTimer);
                    gameLaunchTimer = null;
                }
                if (gameflowPollTimer) {
                    clearInterval(gameflowPollTimer);
                    gameflowPollTimer = null;
                }
            };

            /**
             * 处理 abort 事件
             */
            const onAbort = () => {
                logger.info("[LobbyState] 收到取消信号，停止等待");
                safeResolve('interrupted');
            };

            /**
             * 启动接受对局后的 gameLaunchTimeout，并开启 gameflow REST 兜底轮询
             */
            const startGameLaunchWatch = () => {
                if (gameLaunchTimer || isResolved) return;

                logger.info(`[LobbyState] 已接受对局，启动 ${GAME_LAUNCH_TIMEOUT_MS / 1000} 秒进游戏超时兜底`);
                gameLaunchTimer = setTimeout(() => {
                    void handleGameLaunchTimeout();
                }, GAME_LAUNCH_TIMEOUT_MS);

                gameflowPollTimer = setInterval(() => {
                    void checkGameflowFallback();
                }, GAMEFLOW_POLL_INTERVAL_MS);
            };

            /**
             * 执行重连恢复（同一时间只允许一个）
             */
            const runRecovery = async (reason: string): Promise<void> => {
                if (isRecovering || isResolved) return;
                isRecovering = true;
                try {
                    logger.info(`[LobbyState] 检测到 ${reason}，尝试自动恢复`);
                    await recovery.reconnectWithRetries(reason, signal);
                } catch (error) {
                    logger.warn(`[LobbyState] 自动恢复异常: ${error instanceof Error ? error.message : String(error)}`);
                } finally {
                    isRecovering = false;
                }
            };

            /**
             * 在超时/兜底时主动查询真实状态并决定下一步
             */
            const resolveByRealPhase = async (): Promise<void> => {
                const phase = await recovery.readPhase();
                logger.info(`[LobbyState] 查询到真实 gameflow 阶段: ${phase ?? '未知'}`);

                if (phase === 'InProgress') {
                    safeResolve('started');
                    return;
                }

                if (GameflowRecovery.isAbnormalPhase(phase)) {
                    await runRecovery(String(phase));
                    // 恢复后再查一次
                    const afterPhase = await recovery.readPhase();
                    logger.info(`[LobbyState] 恢复后 gameflow 阶段: ${afterPhase ?? '未知'}`);
                    if (afterPhase === 'InProgress') {
                        safeResolve('started');
                    } else {
                        safeResolve('requeue');
                    }
                    return;
                }

                // 已回到大厅 / 主界面 / 未知
                safeResolve('requeue');
            };

            /**
             * 接受对局后的进游戏超时处理
             */
            const handleGameLaunchTimeout = async () => {
                logger.warn(`[LobbyState] 接受对局后 ${GAME_LAUNCH_TIMEOUT_MS / 1000} 秒仍未进入游戏，主动查询真实状态...`);
                await resolveByRealPhase();
            };

            /**
             * gameflow REST 兜底轮询（处理 WebSocket 丢事件）
             */
            const checkGameflowFallback = async () => {
                if (isResolved || isGameflowChecking) return;
                isGameflowChecking = true;
                try {
                    const phase = await recovery.readPhase();
                    if (isResolved) return;

                    if (phase === 'InProgress') {
                        logger.info("[LobbyState] REST 兜底检测到 InProgress");
                        safeResolve('started');
                        return;
                    }

                    if (GameflowRecovery.isAbnormalPhase(phase)) {
                        logger.info(`[LobbyState] REST 兜底检测到异常阶段: ${phase}`);
                        void runRecovery(String(phase));
                        return;
                    }

                    if (phase === 'TerminatedInError') {
                        logger.warn("[LobbyState] REST 兜底检测到 TerminatedInError");
                        safeResolve('error');
                    }
                } finally {
                    isGameflowChecking = false;
                }
            };

            /**
             * 监听"找到对局"事件，自动接受
             * 使用节流：100ms内只调用一次 acceptMatch
             * 接受后不彻底取消超时，而是切换为 gameLaunchTimeout
             */
            const onReadyCheck = (eventData: LCUWebSocketMessage) => {
                const now = Date.now();
                if (eventData.data?.state === "InProgress" && now - lastAcceptTime >= 100) {
                    lastAcceptTime = now;
                    hasAccepted = true;

                    // 已接受对局，取消排队超时定时器，改用进游戏超时兜底
                    if (queueTimeoutTimer) {
                        clearTimeout(queueTimeoutTimer);
                        queueTimeoutTimer = null;
                        logger.info("[LobbyState] 已找到对局，取消排队超时定时器");
                    }

                    logger.info("[LobbyState] 已找到对局！正在自动接受...");
                    this.deps.lcu?.acceptMatch()
                        .then(() => {
                            if (hasAccepted) startGameLaunchWatch();
                        })
                        .catch((reason) => {
                            logger.warn(`[LobbyState] 接受对局失败: ${reason}`);
                        });
                }
            };

            /**
             * 监听"游戏阶段变化"事件
             */
            const onGameflowPhase = (eventData: LCUWebSocketMessage) => {
                const phase = eventData.data?.phase as GameFlowPhase | undefined;
                logger.info(`[LobbyState] 监听到游戏阶段: ${phase}`);

                if (phase === "InProgress") {
                    logger.info("[LobbyState] 监听到 GAMEFLOW 变为 InProgress");
                    safeResolve('started');
                } else if (phase === "TerminatedInError") {
                    logger.warn("[LobbyState] 监听到 GAMEFLOW 变为 TerminatedInError");
                    safeResolve('error');
                } else if (GameflowRecovery.isAbnormalPhase(phase)) {
                    logger.info(`[LobbyState] 监听到异常 gameflow 阶段: ${phase}`);
                    void runRecovery(String(phase));
                }
            };

            // 监听 abort 事件
            signal.addEventListener("abort", onAbort, { once: true });

            // 注册 LCU 事件监听器
            this.deps.lcu?.on(LcuEventUri.READY_CHECK, onReadyCheck);
            this.deps.lcu?.on(LcuEventUri.GAMEFLOW_PHASE, onGameflowPhase);

            // 定期检查 signal 状态 (作为 abort 事件的兜底)
            stopCheckInterval = setInterval(() => {
                if (signal.aborted) {
                    safeResolve('interrupted');
                }
            }, ABORT_CHECK_INTERVAL_MS);

            // 如果设置了超时时间，启动排队超时定时器
            if (timeoutMs > 0) {
                logger.info(`[LobbyState] 排队超时机制：${timeoutMs / 1000}秒内未找到对局将退出重试`);
                queueTimeoutTimer = setTimeout(() => {
                    logger.warn("[LobbyState] 排队超时！");
                    safeResolve('timeout');
                }, timeoutMs);
            }
        });
    }
}
