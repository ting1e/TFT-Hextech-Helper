import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LobbyState } from '../LobbyState';
import { GameLoadingState } from '../GameLoadingState';
import { EndState } from '../EndState';
import { StartState } from '../StartState';
import { createMockDeps, MockDepsBundle } from '../../../test/helpers/fakes';

/** 通过 vi.hoisted 暴露给被 mock 的 DefaultStateDeps 模块 */
const hoisted = vi.hoisted(() => ({ bundle: null as MockDepsBundle | null }));

vi.mock('../DefaultStateDeps', () => ({
    getDefaultStateDeps: () => hoisted.bundle!.deps,
}));

/** 推进 fake timers 并刷新微任务 */
async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
}

describe('LobbyState', () => {
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

    /** 走到 waitForGameToStart 注册好监听器（创建房间 + 排队） */
    async function runToWait(): Promise<void> {
        // 创建房间后的 500ms 等待
        await advance(600);
    }

    it('正常流程：ReadyCheck → InProgress → GameLoadingState', async () => {
        const state = new LobbyState(bundle.deps);
        const promise = state.action(controller.signal);

        await runToWait();
        bundle.lcu.emitReadyCheck('InProgress');
        await advance(10);
        expect(bundle.lcu.acceptCalls).toBe(1);

        bundle.lcu.emitGameflowPhase('InProgress');
        const next = await promise;
        expect(next).toBeInstanceOf(GameLoadingState);
    });

    it('REST 兜底：WebSocket 丢失 InProgress 事件时仍能检测到游戏开始', async () => {
        const state = new LobbyState(bundle.deps);
        const promise = state.action(controller.signal);

        await runToWait();
        bundle.lcu.emitReadyCheck('InProgress');
        await advance(10);

        // 故意不发 WebSocket 事件，仅让 REST 返回 InProgress
        bundle.lcu.phase = 'InProgress';
        await advance(2000);

        const next = await promise;
        expect(next).toBeInstanceOf(GameLoadingState);
    });

    it('进游戏超时但真实状态为 Lobby → 重新排队（返回自身）', async () => {
        const state = new LobbyState(bundle.deps);
        const promise = state.action(controller.signal);

        await runToWait();
        bundle.lcu.emitReadyCheck('InProgress');
        await advance(10);

        bundle.lcu.phase = 'Lobby';
        // 触发进游戏超时 (75s)，同时 REST 轮询也一直是 Lobby
        await advance(76_000);

        const next = await promise;
        expect(next).toBe(state);
    });

    it('进游戏超时且真实状态为 Reconnect → 自动重连后进入游戏', async () => {
        const state = new LobbyState(bundle.deps);
        const promise = state.action(controller.signal);

        await runToWait();
        bundle.lcu.emitReadyCheck('InProgress');
        await advance(10);

        // 超时那一刻先是 Reconnect，恢复后再查变为 InProgress
        bundle.lcu.phaseSequence = ['Reconnect', 'InProgress'];
        await advance(76_000);

        const next = await promise;
        expect(bundle.lcu.reconnectCalls).toBeGreaterThanOrEqual(1);
        expect(next).toBeInstanceOf(GameLoadingState);
    });

    it('WebSocket 收到异常阶段 Reconnect → 自动重连', async () => {
        const state = new LobbyState(bundle.deps);
        const promise = state.action(controller.signal);

        await runToWait();
        bundle.lcu.emitReadyCheck('InProgress');
        await advance(10);

        bundle.lcu.emitGameflowPhase('Reconnect');
        await advance(5000);

        expect(bundle.lcu.reconnectCalls).toBeGreaterThanOrEqual(1);

        bundle.lcu.emitGameflowPhase('InProgress');
        const next = await promise;
        expect(next).toBeInstanceOf(GameLoadingState);
    });

    it('TerminatedInError → 重新开始 LobbyState', async () => {
        const state = new LobbyState(bundle.deps);
        const promise = state.action(controller.signal);

        await runToWait();
        bundle.lcu.emitGameflowPhase('TerminatedInError');
        const next = await promise;
        expect(next).toBe(state);
    });

    it('排队超时（未接受对局）→ 退出房间并进入 StartState', async () => {
        bundle.settingsMap.queueTimeout = { enabled: true, minutes: 1 };
        const state = new LobbyState(bundle.deps);
        const promise = state.action(controller.signal);

        await runToWait();
        // 触发排队超时
        await advance(61_000);

        const next = await promise;
        expect(bundle.lcu.leaveLobbyCalls).toBeGreaterThanOrEqual(1);
        expect(next).toBeInstanceOf(StartState);
    });

    it('用户停止 → EndState', async () => {
        const state = new LobbyState(bundle.deps);
        const promise = state.action(controller.signal);

        await runToWait();
        controller.abort();
        await advance(600);

        const next = await promise;
        expect(next).toBeInstanceOf(EndState);
    });

    it('LCU 临时异常：查询 gameflow 失败后仍可继续运行', async () => {
        const state = new LobbyState(bundle.deps);
        const promise = state.action(controller.signal);

        await runToWait();
        bundle.lcu.emitReadyCheck('InProgress');
        await advance(10);

        // 连续几次 REST 查询失败
        bundle.lcu.gameflowShouldFail = true;
        await advance(5000);

        // 恢复后 WebSocket 正常进入游戏
        bundle.lcu.gameflowShouldFail = false;
        bundle.lcu.emitGameflowPhase('InProgress');
        const next = await promise;
        expect(next).toBeInstanceOf(GameLoadingState);
    });
});
