import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GameRunningState } from '../GameRunningState';
import { LobbyState } from '../LobbyState';
import { EndState } from '../EndState';
import { createMockDeps, MockDepsBundle } from '../../../test/helpers/fakes';

const hoisted = vi.hoisted(() => ({ bundle: null as MockDepsBundle | null }));

vi.mock('../DefaultStateDeps', () => ({
    getDefaultStateDeps: () => hoisted.bundle!.deps,
}));

async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
}

describe('GameRunningState', () => {
    let bundle: MockDepsBundle;
    let controller: AbortController;

    beforeEach(() => {
        vi.useFakeTimers();
        bundle = createMockDeps();
        hoisted.bundle = bundle;
        controller = new AbortController();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    /**
     * 启动状态并等待进入 waitForGameToEnd
     * @description 返回 { promise } 对象，避免 await 递归拆包内层的 action promise 造成死锁
     */
    async function startRunning(): Promise<{ promise: Promise<any> }> {
        const state = new GameRunningState(bundle.deps);
        const promise = state.action(controller.signal);
        // 刷新初始化流程中的微任务
        await advance(1);
        return { promise };
    }

    it('WebSocket WaitingForStats → 跳过结算 → 返回 LobbyState', async () => {
        const { promise } = await startRunning();

        bundle.lcu.phase = 'Lobby';
        bundle.lcu.emitGameflowPhase('WaitingForStats');
        await advance(2000);
        const next = await promise;

        expect(bundle.lcu.dismissCalls).toBeGreaterThanOrEqual(1);
        expect(bundle.deps.hexService.recordGameCompleted).toHaveBeenCalled();
        expect(next).toBeInstanceOf(LobbyState);
    });

    it('WebSocket EndOfGame → 跳过结算', async () => {
        const { promise } = await startRunning();

        bundle.lcu.phase = 'Lobby';
        bundle.lcu.emitGameflowPhase('EndOfGame');
        await advance(2000);
        const next = await promise;

        expect(bundle.lcu.dismissCalls).toBeGreaterThanOrEqual(1);
        expect(next).toBeInstanceOf(LobbyState);
    });

    it('PreEndOfGame 被视为结束', async () => {
        const { promise } = await startRunning();

        bundle.lcu.phase = 'Lobby';
        bundle.lcu.emitGameflowPhase('PreEndOfGame');
        await advance(2000);
        const next = await promise;

        expect(bundle.lcu.dismissCalls).toBeGreaterThanOrEqual(1);
        expect(next).toBeInstanceOf(LobbyState);
    });

    it('WebSocket 丢事件：REST watchdog 检测到 EndOfGame 后自动恢复', async () => {
        const { promise } = await startRunning();

        // 完全不发 WebSocket 事件，仅 REST 返回 EndOfGame
        bundle.lcu.phase = 'EndOfGame';
        await advance(1600);
        expect(bundle.lcu.dismissCalls).toBeGreaterThanOrEqual(1);

        // 结算页关闭后回到大厅
        bundle.lcu.phase = 'Lobby';
        await advance(1600);
        const next = await promise;
        expect(next).toBeInstanceOf(LobbyState);
    });

    it('游戏过程中检测到 Reconnect → 自动重连', async () => {
        const { promise } = await startRunning();

        bundle.lcu.emitGameflowPhase('Reconnect');
        await advance(100);
        expect(bundle.lcu.reconnectCalls).toBeGreaterThanOrEqual(1);

        bundle.lcu.phase = 'Lobby';
        bundle.lcu.emitGameflowPhase('WaitingForStats');
        await advance(2000);
        const next = await promise;
        expect(next).toBeInstanceOf(LobbyState);
    });

    it('本局结束后停止：停止挂机并进入 EndState', async () => {
        bundle.deps.hexService.stopAfterCurrentGame = true;
        const { promise } = await startRunning();

        bundle.lcu.phase = 'Lobby';
        bundle.lcu.emitGameflowPhase('WaitingForStats');
        await advance(2000);
        const next = await promise;

        expect(bundle.deps.hexService.stop).toHaveBeenCalled();
        expect(bundle.deps.notifyHexRunningState).toHaveBeenCalledWith(false);
        expect(next).toBeInstanceOf(EndState);
    });

    it('用户停止 → EndState', async () => {
        const { promise } = await startRunning();

        controller.abort();
        await advance(100);
        const next = await promise;
        expect(next).toBeInstanceOf(EndState);
    });

    it('资源清理：结束时停止 Monitor 与 StrategyService', async () => {
        const { promise } = await startRunning();

        bundle.lcu.phase = 'Lobby';
        bundle.lcu.emitGameflowPhase('WaitingForStats');
        await advance(2000);
        await promise;

        expect(bundle.deps.gameStageMonitor.stop).toHaveBeenCalled();
        expect(bundle.deps.strategyService.reset).toHaveBeenCalled();
        expect(bundle.deps.gameStateManager.reset).toHaveBeenCalled();
    });
});
