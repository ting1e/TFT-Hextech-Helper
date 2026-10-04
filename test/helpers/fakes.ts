/**
 * 测试用假依赖集合
 * @description 为状态机测试提供纯内存的 LCU / InGameApi / 各服务桩实现，
 *              不依赖实机、Electron 与原生模块。
 */

import { EventEmitter } from 'events';
import { vi } from 'vitest';
import type { GameFlowPhase } from '../../src-backend/lcu/utils/LCUProtocols';
import type { StateDeps } from '../../src-backend/states/StateDeps';

/**
 * 假的 LCU 客户端
 * @description 通过事件名广播 WebSocket 事件（与真实 LCUManager 的 on/off 行为一致）
 */
export class FakeLcu extends EventEmitter {
    /** 当前 gameflow 阶段（REST 查询返回） */
    public phase: GameFlowPhase | undefined = 'Lobby';
    /** 阶段序列：非空时按顺序弹出作为 REST 查询结果 */
    public phaseSequence: (GameFlowPhase | undefined)[] = [];
    /** 是否让 getGameflowPhase 抛错（模拟 LCU 临时异常） */
    public gameflowShouldFail = false;
    /** 是否让 reconnectGame 抛错 */
    public reconnectShouldFail = false;
    /** 是否让 dismissEndOfGameStats 抛错 */
    public dismissShouldFail = false;

    public reconnectCalls = 0;
    public dismissCalls = 0;
    public killCalls = 0;
    public quitCalls = 0;
    public acceptCalls = 0;
    public createLobbyCalls = 0;
    public startMatchCalls = 0;
    public leaveLobbyCalls = 0;

    /** 记录所有调用的顺序，便于断言恢复流程 */
    public callLog: string[] = [];

    async getGameflowPhase(): Promise<GameFlowPhase | undefined> {
        if (this.gameflowShouldFail) {
            throw new Error('LCU GET session 500');
        }
        if (this.phaseSequence.length > 0) {
            return this.phaseSequence.shift();
        }
        return this.phase;
    }

    async getGameflowSession(): Promise<any> {
        return { phase: await this.getGameflowPhase() };
    }

    async reconnectGame(): Promise<any> {
        this.reconnectCalls++;
        this.callLog.push('reconnect');
        if (this.reconnectShouldFail) throw new Error('reconnect failed');
        return {};
    }

    async dismissEndOfGameStats(): Promise<any> {
        this.dismissCalls++;
        this.callLog.push('dismiss');
        if (this.dismissShouldFail) throw new Error('dismiss failed');
        return {};
    }

    async killGameProcess(): Promise<boolean> {
        this.killCalls++;
        this.callLog.push('kill');
        return true;
    }

    async quitGame(): Promise<any> {
        this.quitCalls++;
        this.callLog.push('quit');
        return {};
    }

    async acceptMatch(): Promise<any> {
        this.acceptCalls++;
        this.callLog.push('accept');
        return {};
    }

    async createLobbyByQueueId(_queueId: number): Promise<any> {
        this.createLobbyCalls++;
        return {};
    }

    async startMatch(): Promise<any> {
        this.startMatchCalls++;
        return {};
    }

    async leaveLobby(): Promise<any> {
        this.leaveLobbyCalls++;
        return {};
    }

    /** 模拟 WebSocket 广播 gameflow 阶段事件 */
    public emitGameflowPhase(phase: GameFlowPhase): void {
        this.emit('/lol-gameflow/v1/session', {
            uri: '/lol-gameflow/v1/session',
            eventType: 'Update',
            data: { phase },
        });
    }

    /** 模拟 WebSocket 广播 ReadyCheck 事件 */
    public emitReadyCheck(state: 'InProgress' | 'Invalid' = 'InProgress'): void {
        this.emit('/lol-matchmaking/v1/ready-check', {
            uri: '/lol-matchmaking/v1/ready-check',
            eventType: 'Update',
            data: { state },
        });
    }
}

/** InGame API 假实现 */
export interface FakeInGameApi {
    available: boolean;
    get: ReturnType<typeof vi.fn>;
}

/** 测试依赖集合 */
export interface MockDepsBundle {
    deps: StateDeps;
    lcu: FakeLcu;
    inGameApi: FakeInGameApi;
    settingsMap: Record<string, any>;
}

/**
 * 创建一个完整的 StateDeps 假实现
 * @param overrides 可覆盖任意依赖字段
 */
export function createMockDeps(overrides: Partial<StateDeps> = {}): MockDepsBundle {
    const lcu = (overrides.lcu as FakeLcu) ?? new FakeLcu();

    const inGameApi: FakeInGameApi = (overrides.inGameApi as FakeInGameApi) ?? {
        available: false,
        get: vi.fn(),
    };
    if (!inGameApi.get.getMockImplementation()) {
        inGameApi.get.mockImplementation(async () => {
            if (inGameApi.available) {
                return { data: { allPlayers: [] } };
            }
            throw new Error('InGame API 不可用');
        });
    }

    const settingsMap: Record<string, any> = {
        tftMode: 'NORMAL',
        showOverlay: false,
        queueTimeout: { enabled: false, minutes: 0 },
        queueRandomDelay: { enabled: false, minSeconds: 0, maxSeconds: 0 },
    };

    const deps: StateDeps = {
        lcu,
        inGameApi: inGameApi as any,
        tftOperator: {
            init: vi.fn(async () => ({ success: true, windowInfo: { width: 1024, height: 768, left: 0, top: 0 } })),
            clickClockworkQuitButton: vi.fn(async () => undefined),
        },
        strategyService: {
            initialize: vi.fn(() => true),
            subscribe: vi.fn(),
            reset: vi.fn(),
            setGameEnded: vi.fn(),
        },
        gameStageMonitor: Object.assign(new EventEmitter(), {
            start: vi.fn(),
            stop: vi.fn(),
            reset: vi.fn(),
            startClockworkDeadPoll: vi.fn(),
        }) as any,
        gameStateManager: {
            startGame: vi.fn(),
            reset: vi.fn(),
        },
        hexService: {
            recordGameCompleted: vi.fn(),
            stopAfterCurrentGame: false,
            stop: vi.fn(async () => true),
        },
        settings: {
            get: vi.fn((key: string) => settingsMap[key]),
        },
        templateLoader: {
            switchSeason: vi.fn(async () => undefined),
        },
        ocrService: {
            switchChessWorker: vi.fn(async () => undefined),
        },
        overlay: {
            showOverlay: vi.fn(),
            closeOverlay: vi.fn(),
            sendOverlayPlayers: vi.fn(),
        },
        windowHelper: {
            findLOLWindow: vi.fn(async () => ({ left: 0, top: 0, width: 1024, height: 768 })),
        },
        toast: {
            success: vi.fn(),
            info: vi.fn(),
            warning: vi.fn(),
        },
        notifyStopAfterGameState: vi.fn(),
        notifyHexRunningState: vi.fn(),
        gameWidth: 1024,
        gameHeight: 768,
        ...overrides,
    };

    return { deps, lcu, inGameApi, settingsMap };
}
