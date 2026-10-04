/**
 * 完整 Mock 集成测试
 * @description 模拟一整局：
 *   Lobby → ReadyCheck → GameStart → Reconnect(故意) → 自动重连
 *   → GameLoading → InProgress → GameRunning
 *   → WebSocket 故意漏掉结束事件 → REST watchdog 检测 EndOfGame
 *   → dismiss-stats → Lobby → 开始下一局
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LobbyState } from '../LobbyState';
import { GameLoadingState } from '../GameLoadingState';
import { GameRunningState } from '../GameRunningState';
import { createMockDeps, MockDepsBundle } from '../../../test/helpers/fakes';

const hoisted = vi.hoisted(() => ({ bundle: null as MockDepsBundle | null }));

vi.mock('../DefaultStateDeps', () => ({
    getDefaultStateDeps: () => hoisted.bundle!.deps,
}));

async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
}

describe('完整对局恢复集成测试', () => {
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

    it('从排队到重连、进入游戏、漏事件恢复、返回大厅的完整链路', async () => {
        // ─────────────────────────────────────────────────────────
        // 1. LobbyState：创建房间 → 排队 → ReadyCheck → 接受对局
        // ─────────────────────────────────────────────────────────
        const lobby = new LobbyState(bundle.deps);
        const lobbyPromise = lobby.action(controller.signal);

        await advance(600); // 创建房间 + 排队
        expect(bundle.lcu.createLobbyCalls).toBe(1);
        expect(bundle.lcu.startMatchCalls).toBe(1);

        bundle.lcu.emitReadyCheck('InProgress');
        await advance(10);
        expect(bundle.lcu.acceptCalls).toBe(1);

        // ─────────────────────────────────────────────────────────
        // 2. 故意制造 Reconnect → 自动重连
        // ─────────────────────────────────────────────────────────
        bundle.lcu.phase = 'Reconnect';
        bundle.lcu.emitGameflowPhase('Reconnect');
        await advance(100);
        expect(bundle.lcu.reconnectCalls).toBeGreaterThanOrEqual(1);

        // 重连后进入游戏
        bundle.lcu.phase = 'InProgress';
        bundle.lcu.emitGameflowPhase('InProgress');
        const loading = await lobbyPromise;
        expect(loading).toBeInstanceOf(GameLoadingState);

        // ─────────────────────────────────────────────────────────
        // 3. GameLoadingState：InGame API 恢复 → GameRunningState
        // ─────────────────────────────────────────────────────────
        bundle.inGameApi.available = false;
        const loadingPromise = loading.action(controller.signal);
        await advance(600); // 前 600ms API 不可用
        bundle.inGameApi.available = true;
        await advance(600);

        const running = await loadingPromise;
        expect(running).toBeInstanceOf(GameRunningState);

        // ─────────────────────────────────────────────────────────
        // 4. GameRunningState：WebSocket 漏掉结束事件
        //    REST watchdog 检测 EndOfGame → dismiss-stats → Lobby
        // ─────────────────────────────────────────────────────────
        bundle.inGameApi.available = true;
        const runningPromise = running.action(controller.signal);
        await advance(1); // 初始化

        // 关键：不发送任何 WebSocket 结束事件，仅让 REST 返回 EndOfGame
        bundle.lcu.phase = 'EndOfGame';
        await advance(1600);
        expect(bundle.lcu.dismissCalls).toBeGreaterThanOrEqual(1);

        // 结算页跳过后回到大厅
        bundle.lcu.phase = 'Lobby';
        await advance(1600);
        const nextLobby = await runningPromise;

        expect(bundle.deps.hexService.recordGameCompleted).toHaveBeenCalled();
        expect(nextLobby).toBeInstanceOf(LobbyState);

        // ─────────────────────────────────────────────────────────
        // 5. 开始下一局：新 LobbyState 能正常创建房间
        // ─────────────────────────────────────────────────────────
        const secondGamePromise = nextLobby.action(controller.signal);
        await advance(600);
        expect(bundle.lcu.createLobbyCalls).toBe(2);

        // 收尾：停止，避免悬挂的等待
        controller.abort();
        await advance(600);
        await secondGamePromise;
    });
});
