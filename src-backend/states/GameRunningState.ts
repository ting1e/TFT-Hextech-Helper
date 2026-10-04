/**
 * 游戏运行状态
 * @module GameRunningState
 * @description 游戏进行中的状态，负责：
 *              1. 启动 GameStageMonitor（阶段监视器）
 *              2. 启动 StrategyService（策略服务订阅事件）
 *              3. 监听 GAMEFLOW_PHASE / TFT_BATTLE_PASS 事件，等待游戏结束
 *              4. 游戏结束后跳过结算并等待回到大厅，流转到 LobbyState 开始下一局
 *
 * 恢复机制（解决"对局结束后一直等待"）：
 * - 将 WaitingForStats / PreEndOfGame / EndOfGame 统一视为对局结束
 * - 检测到结束后调用 dismissEndOfGameStats() 主动跳过结算
 * - 之后轮询 gameflow，直到进入 None / Lobby 再返回 LobbyState
 * - 游戏过程中发现 Reconnect 自动 reconnectGame()
 * - WebSocket 继续保留，另加每 1.5 秒 REST watchdog，避免结束事件丢失
 *
 * 状态流转：
 * - 游戏结束 → LobbyState（自动开下一局）
 * - 用户手动停止（signalAbort）→ EndState
 */

import { IState } from "./IState";
import { LobbyState } from "./LobbyState";
import { EndState } from "./EndState";
import { LcuEventUri, LCUWebSocketMessage } from "../lcu/LCUManager";
import { InGameApiEndpoints } from "../lcu/InGameApi";
import { GameFlowPhase } from "../lcu/utils/LCUProtocols";
import type { GameStageEvent } from "../services/GameStageMonitor";
import { logger } from "../utils/Logger";
import { sleep } from "../utils/HelperTools";
import { TFTMode, isStandardChessMode } from "../TFTProtocol";
import { getSeasonTemplateDirByMode } from "../TFTInfo/SeasonRegistry";
import { getDefaultStateDeps } from "./DefaultStateDeps";
import type { StateDeps } from "./StateDeps";
import { GameflowRecovery } from "../services/GameflowRecovery";

/** abort 信号轮询间隔 (ms)，作为事件监听的兜底 */
const ABORT_CHECK_INTERVAL_MS = 2000;

/** 发条鸟模式：阶段变化超时时间 (ms)，超过此时间未收到阶段事件则视为卡住 */
const CLOCKWORK_STAGE_TIMEOUT_MS = 60000;  // 1 分钟

/** gameflow REST watchdog 轮询间隔 (ms) */
const GAMEFLOW_WATCHDOG_INTERVAL_MS = 1500;

/** 结束对局后等待回到大厅的硬超时 (ms) */
const RETURN_TO_LOBBY_TIMEOUT_MS = 90000;

/** 自动重连的最大次数 */
const MAX_RECONNECT_ATTEMPTS = 3;

/** 自动重连重试间隔 (ms) */
const RECONNECT_INTERVAL_MS = 5000;

/** 等待游戏结束的返回值 */
export type GameWaitResult = "ended" | "interrupted" | "clockwork_timeout";

/**
 * 游戏运行状态类
 * @description 游戏进行中的主状态，启动 Monitor 后挂起等待游戏结束
 */
export class GameRunningState implements IState {
    /** 状态名称 */
    public readonly name = "GameRunningState";

    /** 依赖集合（可注入，便于测试） */
    private readonly deps: StateDeps;

    constructor(deps?: StateDeps) {
        this.deps = deps ?? getDefaultStateDeps();
    }

    /**
     * 执行游戏运行状态逻辑
     * @param signal AbortSignal 用于取消操作
     * @returns 下一个状态
     */
    async action(signal: AbortSignal): Promise<IState> {
        signal.throwIfAborted();

        logger.info("[GameRunningState] 进入游戏运行状态");

        const recovery = new GameflowRecovery({
            lcu: this.deps.lcu,
            logger,
            maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
            reconnectIntervalMs: RECONNECT_INTERVAL_MS,
        });

        // 1. 标记游戏开始
        this.deps.gameStateManager.startGame();
        logger.info("[GameRunningState] 游戏已开始");

        // 1.5 检测对局中的人机玩家并发送 Toast 通知 + 打开浮窗
        await this.detectAndNotifyBots();

        // 2. 获取当前游戏模式并初始化策略服务
        const currentMode = (this.deps.settings.get('tftMode') as TFTMode) || TFTMode.NORMAL;
        logger.info(`[GameRunningState] 当前游戏模式: ${currentMode}`);

        // 2.5 根据当前模式切换英雄模板赛季
        const seasonDir = getSeasonTemplateDirByMode(currentMode);
        await this.deps.templateLoader.switchSeason(seasonDir);
        logger.debug(`[GameRunningState] 英雄模板已切换到赛季: ${seasonDir}`);

        // 2.6 切换 OCR 棋子识别 Worker 的字符白名单到当前赛季
        await this.deps.ocrService.switchChessWorker(currentMode);

        const initSuccess = this.deps.strategyService.initialize(currentMode);
        if (!initSuccess) {
            // 发条鸟模式不需要阵容，标准下棋模式需要
            if (isStandardChessMode(currentMode)) {
                logger.error("[GameRunningState] 策略服务初始化失败，请先选择阵容");
            }
            // 即使初始化失败，也继续运行（避免卡死）
        }

        // 3. 订阅策略服务到 Monitor 事件
        this.deps.strategyService.subscribe();

        // 4. 启动 GameStageMonitor
        this.deps.gameStageMonitor.start(1000);
        logger.info("[GameRunningState] GameStageMonitor 已启动");

        // 5. 等待游戏结束（发条鸟模式有超时机制）
        const waitResult = await this.waitForGameToEnd(signal, currentMode === TFTMode.CLOCKWORK_TRAILS, recovery);

        // 6. 清理资源
        this.cleanup();

        // 7. 返回下一个状态
        if (signal.aborted) {
            // 用户手动停止
            logger.info("[GameRunningState] 用户手动停止，流转到 EndState");
            return new EndState();
        } else if (waitResult === 'ended') {
            // 游戏正常结束，记录统计数据
            this.deps.hexService.recordGameCompleted();

            // 检查是否设置了"本局结束后停止"
            if (this.deps.hexService.stopAfterCurrentGame) {
                logger.info("[GameRunningState] 游戏结束，检测到【本局结束后停止】标志，停止挂机");
                this.deps.toast.success("本局已结束，自动停止挂机", { position: 'top-center' });
                // 通知前端重置"本局结束后停止"状态（因为是一次性功能，生效后自动取消）
                this.deps.notifyStopAfterGameState(false);

                // 通知前端挂机已停止（更新开关按钮状态）
                this.deps.notifyHexRunningState(false);

                // 调用 hexService.stop() 来正确停止服务
                await this.deps.hexService.stop();

                return new EndState();
            }

            // 跳过结算并等待真正回到大厅，避免"对局结束后一直等待"
            await this.waitForReturnToLobby(signal, recovery);

            // 否则返回大厅开始下一局
            logger.info("[GameRunningState] 游戏结束，流转到 LobbyState 开始下一局");
            return new LobbyState();
        } else if (waitResult === 'clockwork_timeout') {
            // 发条鸟模式：阶段变化超时，游戏可能卡住/无响应
            logger.warn("[GameRunningState] 发条鸟模式阶段超时，强制杀掉游戏进程并重新排队");
            this.deps.toast.warning("发条鸟模式：游戏无响应，正在强制退出...", { position: 'top-center' });

            try {
                await this.deps.lcu?.killGameProcess();
                logger.info("[GameRunningState] 超时：游戏进程已被杀掉");
            } catch (error) {
                logger.warn(`[GameRunningState] 超时：杀掉游戏进程失败: ${error}`);
            }

            try {
                await this.deps.lcu?.quitGame();
                logger.info("[GameRunningState] 超时：LCU 退出游戏请求已发送");
            } catch (error) {
                logger.warn(`[GameRunningState] 超时：LCU 退出游戏请求失败: ${error}`);
            }

            await sleep(3000);
            return new LobbyState();
        } else {
            // 异常情况，也返回大厅重试
            logger.warn("[GameRunningState] 异常退出，流转到 LobbyState");
            return new LobbyState();
        }
    }

    /**
     * 跳过结算并等待真正回到大厅/主界面
     * @param signal AbortSignal
     * @param recovery 恢复助手
     */
    private waitForReturnToLobby(signal: AbortSignal, recovery: GameflowRecovery): Promise<void> {
        return new Promise((resolve) => {
            let pollTimer: NodeJS.Timeout | null = null;
            let hardTimeoutTimer: NodeJS.Timeout | null = null;
            let isResolved = false;
            let isChecking = false;

            const cleanup = () => {
                if (pollTimer) {
                    clearInterval(pollTimer);
                    pollTimer = null;
                }
                if (hardTimeoutTimer) {
                    clearTimeout(hardTimeoutTimer);
                    hardTimeoutTimer = null;
                }
                signal.removeEventListener("abort", onAbort);
            };

            const safeResolve = () => {
                if (isResolved) return;
                isResolved = true;
                cleanup();
                resolve();
            };

            const onAbort = () => {
                logger.info("[GameRunningState] 收到取消信号，停止等待返回大厅");
                safeResolve();
            };

            const check = async () => {
                if (isResolved || isChecking) return;
                isChecking = true;
                try {
                    const phase = await recovery.readPhase();
                    if (isResolved) return;

                    if (GameflowRecovery.isLobbyPhase(phase)) {
                        logger.info(`[GameRunningState] 已返回大厅 (${phase})`);
                        safeResolve();
                        return;
                    }

                    if (GameflowRecovery.isEndPhase(phase)) {
                        // 结束页卡住 → 主动跳过结算
                        await recovery.dismissStats(String(phase));
                    }
                } finally {
                    isChecking = false;
                }
            };

            signal.addEventListener("abort", onAbort, { once: true });
            pollTimer = setInterval(() => void check(), GAMEFLOW_WATCHDOG_INTERVAL_MS);
            hardTimeoutTimer = setTimeout(() => {
                logger.warn(`[GameRunningState] 等待返回大厅超时（${RETURN_TO_LOBBY_TIMEOUT_MS / 1000}秒），强制继续`);
                safeResolve();
            }, RETURN_TO_LOBBY_TIMEOUT_MS);

            void check();
        });
    }

    /**
     * 等待游戏结束
     * @param signal AbortSignal 用于取消等待
     * @param isClockworkMode 是否为发条鸟模式
     * @param recovery 恢复助手
     * @returns 'ended' 游戏正常结束；'interrupted' 被中断；'clockwork_timeout' 发条鸟超时
     */
    private waitForGameToEnd(
        signal: AbortSignal,
        isClockworkMode: boolean,
        recovery: GameflowRecovery,
    ): Promise<GameWaitResult> {
        return new Promise((resolve) => {
            let stopCheckInterval: NodeJS.Timeout | null = null;
            let stageTimeoutTimer: NodeJS.Timeout | null = null;
            let watchdogTimer: NodeJS.Timeout | null = null;
            let isResolved = false;
            /** 标记是否已经尝试过退出游戏，避免重复调用 */
            let hasTriedQuit = false;
            /** watchdog 查询是否正在进行 */
            let isWatchdogChecking = false;

            /**
             * 安全的 resolve，防止重复调用
             */
            const safeResolve = (value: GameWaitResult) => {
                if (isResolved) return;
                isResolved = true;
                cleanup();
                resolve(value);
            };

            /**
             * 清理所有监听器和定时器
             */
            const cleanup = () => {
                this.deps.lcu?.off(LcuEventUri.GAMEFLOW_PHASE, onGameflowPhase);
                this.deps.lcu?.off(LcuEventUri.TFT_BATTLE_PASS, onBattlePass);
                if (isClockworkMode) {
                    this.deps.gameStageMonitor.off('stageChange', onStageChange);
                    this.deps.gameStageMonitor.off('clockworkDead', onClockworkDead);
                }
                signal.removeEventListener("abort", onAbort);
                if (stopCheckInterval) {
                    clearInterval(stopCheckInterval);
                    stopCheckInterval = null;
                }
                if (stageTimeoutTimer) {
                    clearTimeout(stageTimeoutTimer);
                    stageTimeoutTimer = null;
                }
                if (watchdogTimer) {
                    clearInterval(watchdogTimer);
                    watchdogTimer = null;
                }
            };

            /**
             * 标记对局已结束：跳过结算 + resolve
             */
            const handleGameEnded = (phase: string) => {
                logger.info(`[GameRunningState] 检测到对局结束 (${phase})`);
                void recovery.dismissStats(phase);
                safeResolve('ended');
            };

            /**
             * 重置发条鸟模式的阶段超时计时器
             */
            const resetStageTimeout = () => {
                if (stageTimeoutTimer) {
                    clearTimeout(stageTimeoutTimer);
                }
                stageTimeoutTimer = setTimeout(() => {
                    logger.warn(`[GameRunningState] 发条鸟模式：${CLOCKWORK_STAGE_TIMEOUT_MS / 1000}秒内未收到阶段变化事件，判定为游戏卡住`);
                    safeResolve('clockwork_timeout');
                }, CLOCKWORK_STAGE_TIMEOUT_MS);
            };

            const onAbort = () => {
                logger.info("[GameRunningState] 收到取消信号，停止等待");
                safeResolve('interrupted');
            };

            const onStageChange = (_event: GameStageEvent) => {
                logger.debug("[GameRunningState] 发条鸟模式：收到 stageChange 事件，重置超时计时器");
                resetStageTimeout();
            };

            const onClockworkDead = async () => {
                if (isResolved) return;
                hasTriedQuit = true;

                logger.info("[GameRunningState] 发条鸟模式：收到 clockworkDead 事件，点击退出按钮");

                this.deps.strategyService.setGameEnded();
                await this.deps.tftOperator.clickClockworkQuitButton();
            };

            /**
             * 监听 TFT_BATTLE_PASS 事件（玩家死亡/对局结束）
             */
            const onBattlePass = async (_eventData: LCUWebSocketMessage) => {
                if (hasTriedQuit) return;
                hasTriedQuit = true;

                logger.info("[GameRunningState] 收到 TFT_BATTLE_PASS 事件，玩家已死亡/对局结束");

                this.deps.strategyService.setGameEnded();

                // 等待 3s 让玩家看到结算画面
                const EXIT_DELAY_MS = 3000;
                await sleep(EXIT_DELAY_MS);

                logger.info("[GameRunningState] 正在尝试关闭游戏窗口...");

                try {
                    await this.deps.lcu?.killGameProcess();
                    logger.info("[GameRunningState] 游戏进程已被杀掉");
                } catch (error) {
                    logger.warn(`[GameRunningState] 杀掉游戏进程失败: ${error}`);
                }

                try {
                    await this.deps.lcu?.quitGame();
                    logger.info("[GameRunningState] 退出游戏请求已发送");
                } catch (error) {
                    logger.warn(`[GameRunningState] 退出游戏请求失败: ${error}`);
                }
            };

            /**
             * 监听"游戏阶段变化"事件
             * @description WaitingForStats / PreEndOfGame / EndOfGame 统一视为对局结束
             */
            const onGameflowPhase = (eventData: LCUWebSocketMessage) => {
                const phase = eventData.data?.phase as GameFlowPhase | undefined;
                logger.info(`[GameRunningState] 监听到游戏阶段: ${phase}`);

                if (phase && GameflowRecovery.isEndPhase(phase)) {
                    handleGameEnded(phase);
                    return;
                }

                if (GameflowRecovery.isAbnormalPhase(phase)) {
                    logger.info(`[GameRunningState] 检测到异常 gameflow 阶段: ${phase}`);
                    void recovery.reconnect(String(phase));
                }
            };

            /**
             * REST watchdog：每 1.5 秒查询一次真实 gameflow，避免 WebSocket 丢结束事件
             */
            const watchdogCheck = async () => {
                if (isResolved || isWatchdogChecking) return;
                isWatchdogChecking = true;
                try {
                    const phase = await recovery.readPhase();
                    if (isResolved) return;

                    if (GameflowRecovery.isEndPhase(phase)) {
                        logger.info(`[GameRunningState] REST watchdog 检测到结束阶段: ${phase}`);
                        handleGameEnded(String(phase));
                        return;
                    }

                    if (GameflowRecovery.isAbnormalPhase(phase)) {
                        logger.info(`[GameRunningState] REST watchdog 检测到异常阶段: ${phase}`);
                        void recovery.reconnect(String(phase));
                        return;
                    }

                    // 已经回到大厅/主界面，说明对局已结束
                    if (GameflowRecovery.isLobbyPhase(phase)) {
                        logger.info(`[GameRunningState] REST watchdog 检测到已回到 ${phase}，判定对局结束`);
                        handleGameEnded(String(phase));
                    }
                } finally {
                    isWatchdogChecking = false;
                }
            };

            // 监听 abort 事件
            signal.addEventListener("abort", onAbort, { once: true });

            // 注册 LCU 事件监听器
            this.deps.lcu?.on(LcuEventUri.TFT_BATTLE_PASS, onBattlePass);
            this.deps.lcu?.on(LcuEventUri.GAMEFLOW_PHASE, onGameflowPhase);

            // REST watchdog
            watchdogTimer = setInterval(() => void watchdogCheck(), GAMEFLOW_WATCHDOG_INTERVAL_MS);

            // 发条鸟模式：监听 stageChange + clockworkDead 事件，启动超时计时器 + isDead 轮询
            if (isClockworkMode) {
                logger.info(`[GameRunningState] 发条鸟模式：启动阶段超时监控 (${CLOCKWORK_STAGE_TIMEOUT_MS / 1000}秒)`);
                this.deps.gameStageMonitor.on('stageChange', onStageChange);
                this.deps.gameStageMonitor.on('clockworkDead', onClockworkDead);
                resetStageTimeout();

                this.deps.gameStageMonitor.startClockworkDeadPoll();
            }

            // 定期检查 signal 状态 (作为 abort 事件的兜底)
            stopCheckInterval = setInterval(() => {
                if (signal.aborted) {
                    safeResolve('interrupted');
                }
            }, ABORT_CHECK_INTERVAL_MS);
        });
    }

    /**
     * 检测对局中的人机玩家并发送 Toast 通知
     */
    private async detectAndNotifyBots(): Promise<void> {
        try {
            const response = await this.deps.inGameApi.get(InGameApiEndpoints.ALL_GAME_DATA);
            const gameData = response.data;

            const allPlayers = gameData?.allPlayers || [];
            const botPlayers = allPlayers.filter((player: any) => player.isBot === true);

            const botNames = botPlayers.map((player: any) => player.riotIdGameName || player.summonerName);

            if (botNames.length > 0) {
                const message = `对局已开始！本局有 ${botNames.length} 个人机：${botNames.join('、')}`;
                this.deps.toast.info(message, { position: 'top-center' });
                logger.info(`[GameRunningState] ${message}`);
            } else {
                this.deps.toast.info("对局已开始！本局全是真人玩家", { position: 'top-center' });
                logger.info("[GameRunningState] 对局已开始，本局全是真人玩家");
            }

            // ============================================================
            // 打开游戏浮窗并发送玩家数据
            // ============================================================
            const overlayEnabled = this.deps.settings.get('showOverlay');
            if (!overlayEnabled) {
                logger.debug('[GameRunningState] 用户已关闭游戏浮窗，跳过浮窗显示');
            } else {
                const windowInfo = await this.deps.windowHelper.findLOLWindow();

                if (windowInfo) {
                    this.deps.overlay.showOverlay({
                        left: windowInfo.left,
                        top: windowInfo.top,
                        width: windowInfo.width,
                        height: windowInfo.height,
                    });

                    const playerData = allPlayers.map((player: any) => ({
                        name: player.riotIdGameName || player.summonerName || '未知玩家',
                        isBot: player.isBot === true,
                    }));
                    this.deps.overlay.sendOverlayPlayers(playerData);
                    logger.debug(`[GameRunningState] 已请求发送 ${playerData.length} 个玩家数据到浮窗`);
                } else {
                    logger.warn('[GameRunningState] 未找到游戏窗口，跳过浮窗显示');
                }
            }
        } catch (error: any) {
            logger.warn(`[GameRunningState] 检测人机玩家失败: ${error.message}`);
            this.deps.toast.info("对局已开始！", { position: 'top-center' });
        }
    }

    /**
     * 清理资源
     */
    private cleanup(): void {
        this.deps.overlay.closeOverlay();
        logger.debug("[GameRunningState] 游戏浮窗已关闭");

        this.deps.gameStageMonitor.stop();
        this.deps.gameStageMonitor.reset();
        logger.info("[GameRunningState] GameStageMonitor 已停止并重置");

        this.deps.strategyService.reset();
        logger.info("[GameRunningState] StrategyService 已重置");

        this.deps.gameStateManager.reset();
        logger.info("[GameRunningState] GameStateManager 已重置");
    }
}
