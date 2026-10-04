import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GameLoadingState } from '../GameLoadingState';
import { GameRunningState } from '../GameRunningState';
import { EndState } from '../EndState';
import { LobbyState } from '../LobbyState';
import { createMockDeps, MockDepsBundle } from '../../../test/helpers/fakes';

const hoisted = vi.hoisted(() => ({ bundle: null as MockDepsBundle | null }));

vi.mock('../DefaultStateDeps', () => ({
    getDefaultStateDeps: () => hoisted.bundle!.deps,
}));

async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
}

describe('GameLoadingState', () => {
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

    it('正常：InGame API 可用 → GameRunningState 并初始化 TftOperator', async () => {
        bundle.inGameApi.available = true;
        const state = new GameLoadingState(bundle.deps);
        const next = await state.action(controller.signal);

        expect(next).toBeInstanceOf(GameRunningState);
        expect(bundle.deps.tftOperator.init).toHaveBeenCalledOnce();
    });

    it('Reconnect 阶段 → 自动重连 → InGame API 恢复 → GameRunningState', async () => {
        bundle.lcu.phase = 'Reconnect';
        bundle.inGameApi.available = false;

        const state = new GameLoadingState(bundle.deps);
        const promise = state.action(controller.signal);

        // 立即的 gameflow 检查发现 Reconnect
        await advance(3000);
        expect(bundle.lcu.reconnectCalls).toBeGreaterThanOrEqual(1);

        // 重连后 API 恢复
        bundle.inGameApi.available = true;
        bundle.lcu.phase = 'InProgress';
        await advance(600);
        const next = await promise;
        expect(next).toBeInstanceOf(GameRunningState);
    });

    it('FailedToLaunch 阶段 → 自动重连', async () => {
        bundle.lcu.phase = 'FailedToLaunch';
        bundle.inGameApi.available = false;

        const state = new GameLoadingState(bundle.deps);
        const promise = state.action(controller.signal);

        await advance(3000);
        expect(bundle.lcu.reconnectCalls).toBeGreaterThanOrEqual(1);

        bundle.inGameApi.available = true;
        await advance(600);
        const next = await promise;
        expect(next).toBeInstanceOf(GameRunningState);
    });

    it('InProgress 但 InGame API 卡住 15 秒 → 触发重连 → API 恢复', async () => {
        bundle.lcu.phase = 'InProgress';
        bundle.inGameApi.available = false;

        const state = new GameLoadingState(bundle.deps);
        const promise = state.action(controller.signal);

        // 15 秒之前不应重连
        await advance(5000);
        expect(bundle.lcu.reconnectCalls).toBe(0);

        // 超过 15 秒后触发重连
        await advance(12_000);
        expect(bundle.lcu.reconnectCalls).toBeGreaterThanOrEqual(1);

        bundle.inGameApi.available = true;
        await advance(600);
        const next = await promise;
        expect(next).toBeInstanceOf(GameRunningState);
    });

    it('重连连续失败 → 执行 kill + 最终重连兜底', async () => {
        bundle.lcu.phase = 'Reconnect';
        bundle.lcu.reconnectShouldFail = true;
        bundle.inGameApi.available = false;

        const state = new GameLoadingState(bundle.deps);
        const promise = state.action(controller.signal);

        // 3 次常规重连 + 最终兜底，需要推进足够时间
        await advance(60_000);
        expect(bundle.lcu.reconnectCalls).toBeGreaterThanOrEqual(4);
        expect(bundle.lcu.killCalls).toBeGreaterThanOrEqual(1);

        // 兜底后 API 恢复
        bundle.lcu.reconnectShouldFail = false;
        bundle.inGameApi.available = true;
        bundle.lcu.phase = 'InProgress';
        await advance(600);
        const next = await promise;
        expect(next).toBeInstanceOf(GameRunningState);
    });

    it('硬超时后执行最终恢复并回到 LobbyState', async () => {
        bundle.lcu.phase = 'Lobby';
        bundle.inGameApi.available = false;

        const state = new GameLoadingState(bundle.deps);
        const promise = state.action(controller.signal);

        // 推进超过硬超时 (3 分钟)
        await advance(181_000);

        const next = await promise;
        expect(next).toBeInstanceOf(LobbyState);
    });

    it('用户停止 → EndState', async () => {
        bundle.lcu.phase = 'Lobby';
        bundle.inGameApi.available = false;

        const state = new GameLoadingState(bundle.deps);
        const promise = state.action(controller.signal);

        controller.abort();
        await advance(600);

        const next = await promise;
        expect(next).toBeInstanceOf(EndState);
    });

    it('LCU 临时异常（GET session 失败）后状态机仍能继续', async () => {
        bundle.lcu.gameflowShouldFail = true;
        bundle.inGameApi.available = false;

        const state = new GameLoadingState(bundle.deps);
        const promise = state.action(controller.signal);

        // 查询失败不应导致抛出
        await advance(5000);
        expect(bundle.lcu.reconnectCalls).toBe(0);

        bundle.lcu.gameflowShouldFail = false;
        bundle.inGameApi.available = true;
        await advance(600);
        const next = await promise;
        expect(next).toBeInstanceOf(GameRunningState);
    });
});
