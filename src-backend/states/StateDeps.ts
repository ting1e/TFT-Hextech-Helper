/**
 * 状态机依赖接口
 * @module StateDeps
 * @description 定义各个状态运行时所依赖的外部能力。
 *
 * 设计目的：
 * - 生产环境通过 `DefaultStateDeps` 注入真实的 LCUManager / InGameApi / TftOperator 等单例
 * - 单元测试可以注入纯 fake 实现，从而不依赖实机、Electron 和原生模块
 *
 * 注意：本文件只包含类型/接口，不导入任何重量级模块，可被测试安全引用。
 */

import type { GameFlowPhase } from "../lcu/utils/LCUProtocols";

/** LCU 客户端能力 */
export interface LcuDeps {
    getGameflowPhase(): Promise<GameFlowPhase | undefined>;
    getGameflowSession(): Promise<any>;
    reconnectGame(): Promise<any>;
    dismissEndOfGameStats(): Promise<any>;
    killGameProcess(): Promise<boolean>;
    quitGame(): Promise<any>;
    acceptMatch(): Promise<any>;
    createLobbyByQueueId(queueId: number): Promise<any>;
    startMatch(): Promise<any>;
    leaveLobby(): Promise<any>;
    on(event: string, listener: (...args: any[]) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
}

/** 游戏内 API 能力 */
export interface InGameApiDeps {
    get(endpoint: string): Promise<any>;
}

/** TftOperator 能力（仅状态机用到的部分） */
export interface TftOperatorDeps {
    init(): Promise<{ success: boolean; windowInfo?: { width: number; height: number; left: number; top: number } }>;
    clickClockworkQuitButton(): Promise<any>;
}

/** StrategyService 能力 */
export interface StrategyServiceDeps {
    initialize(mode: any): boolean;
    subscribe(): void;
    reset(): void;
    setGameEnded(): void;
}

/** GameStageMonitor 能力 */
export interface GameStageMonitorDeps {
    start(interval?: number): void;
    stop(): void;
    reset(): void;
    on(event: string, listener: (...args: any[]) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
    startClockworkDeadPoll(): void;
}

/** GameStateManager 能力 */
export interface GameStateManagerDeps {
    startGame(): void;
    reset(): void;
}

/** HexService 能力（仅状态机用到的部分） */
export interface HexServiceDeps {
    recordGameCompleted(): void;
    readonly stopAfterCurrentGame: boolean;
    stop(): Promise<boolean>;
}

/** 设置存储能力 */
export interface SettingsDeps {
    get(key: string): any;
}

/** 模板加载器能力 */
export interface TemplateLoaderDeps {
    switchSeason(seasonDir: string): Promise<void>;
}

/** OCR 服务能力 */
export interface OcrServiceDeps {
    switchChessWorker(mode: any): Promise<void>;
}

/** 游戏浮窗能力 */
export interface OverlayDeps {
    showOverlay(info: { left: number; top: number; width: number; height: number }): void;
    closeOverlay(): void;
    sendOverlayPlayers(players: { name: string; isBot: boolean }[]): void;
}

/** 窗口辅助能力 */
export interface WindowHelperDeps {
    findLOLWindow(): Promise<{ left: number; top: number; width: number; height: number } | null>;
}

/** Toast 通知能力 */
export interface ToastDeps {
    success(message: string, options?: any): void;
    info(message: string, options?: any): void;
    warning(message: string, options?: any): void;
}

/**
 * 状态机完整依赖集合
 */
export interface StateDeps {
    /** LCU 客户端（未连接时为 null） */
    lcu: LcuDeps | null;
    /** 游戏内 API */
    inGameApi: InGameApiDeps;
    /** TFT 操作器 */
    tftOperator: TftOperatorDeps;
    /** 策略服务 */
    strategyService: StrategyServiceDeps;
    /** 阶段监视器 */
    gameStageMonitor: GameStageMonitorDeps;
    /** 游戏状态管理器 */
    gameStateManager: GameStateManagerDeps;
    /** 海克斯核心服务 */
    hexService: HexServiceDeps;
    /** 设置存储 */
    settings: SettingsDeps;
    /** 季节模板加载器 */
    templateLoader: TemplateLoaderDeps;
    /** OCR 服务 */
    ocrService: OcrServiceDeps;
    /** 游戏浮窗 */
    overlay: OverlayDeps;
    /** 窗口辅助 */
    windowHelper: WindowHelperDeps;
    /** Toast 通知 */
    toast: ToastDeps;
    /** 通知前端"本局结束后停止"状态 */
    notifyStopAfterGameState(state: boolean): void;
    /** 通知前端挂机运行状态 */
    notifyHexRunningState(running: boolean): void;
    /** 固定游戏分辨率 */
    gameWidth: number;
    gameHeight: number;
}
