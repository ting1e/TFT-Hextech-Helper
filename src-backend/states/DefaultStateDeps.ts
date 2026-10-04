/**
 * 默认状态机依赖装配
 * @module DefaultStateDeps
 * @description 把生产环境中的真实单例装配成 StateDeps，供状态机构造函数默认使用。
 *
 * ⚠️ 本文件会导入重量级模块（TftOperator / StrategyService / 浮窗等），
 *    单元测试应通过 `vi.mock(".../DefaultStateDeps", ...)` 替换本模块，
 *    或直接向状态构造函数传入显式依赖。
 */

import LCUManager from "../lcu/LCUManager";
import { inGameApi } from "../lcu/InGameApi";
import { tftOperator, GAME_WIDTH, GAME_HEIGHT } from "../TftOperator";
import { strategyService } from "../services/StrategyService";
import { gameStageMonitor } from "../services/GameStageMonitor";
import { gameStateManager } from "../services/GameStateManager";
import { hexService } from "../services/HexService";
import { settingsStore } from "../utils/SettingsStore";
import { templateLoader } from "../tft";
import { ocrService } from "../tft/recognition/OcrService";
import { showOverlay, closeOverlay, sendOverlayPlayers } from "../utils/OverlayBridge";
import { windowHelper } from "../utils/WindowHelper";
import { showToast, notifyStopAfterGameState, notifyHexRunningState } from "../utils/ToastBridge";
import type { StateDeps } from "./StateDeps";

/**
 * 获取生产环境默认依赖集合
 * @description 每次调用都重新装配，确保 LCUManager 断线重连后能拿到最新实例。
 *              其余服务本身就是单例，重复装配成本极低。
 */
export function getDefaultStateDeps(): StateDeps {
    return {
        lcu: LCUManager.getInstance() as unknown as StateDeps["lcu"],
        inGameApi,
        tftOperator: tftOperator as unknown as StateDeps["tftOperator"],
        strategyService: strategyService as unknown as StateDeps["strategyService"],
        gameStageMonitor: gameStageMonitor as unknown as StateDeps["gameStageMonitor"],
        gameStateManager: gameStateManager as unknown as StateDeps["gameStateManager"],
        hexService: hexService as unknown as StateDeps["hexService"],
        settings: settingsStore as unknown as StateDeps["settings"],
        templateLoader: templateLoader as unknown as StateDeps["templateLoader"],
        ocrService: ocrService as unknown as StateDeps["ocrService"],
        overlay: {
            showOverlay,
            closeOverlay,
            sendOverlayPlayers,
        },
        windowHelper: windowHelper as unknown as StateDeps["windowHelper"],
        toast: showToast as unknown as StateDeps["toast"],
        notifyStopAfterGameState,
        notifyHexRunningState,
        gameWidth: GAME_WIDTH,
        gameHeight: GAME_HEIGHT,
    };
}
