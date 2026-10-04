import { describe, it, expect, vi } from 'vitest';
import { GameflowRecovery, RecoveryClock, RecoveryLcuLike, RecoveryLoggerLike } from '../GameflowRecovery';

/** 静默 logger */
const silentLogger: RecoveryLoggerLike = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

/** 可控时钟：sleep 只推进虚拟时间，不产生真实等待 */
function createFakeClock(): RecoveryClock & { advance(ms: number): void } {
    let now = 0;
    return {
        now: () => now,
        sleep: async (ms: number) => {
            now += ms;
        },
        advance: (ms: number) => {
            now += ms;
        },
    };
}

interface FakeLcuOptions {
    reconnectShouldFail?: boolean;
    failFirstNReconnects?: number;
}

function createFakeLcu(options: FakeLcuOptions = {}) {
    let failCount = options.failFirstNReconnects ?? 0;
    const lcu: RecoveryLcuLike & {
        phase: any;
        reconnectCalls: number;
        dismissCalls: number;
        killCalls: number;
    } = {
        phase: 'InProgress',
        reconnectCalls: 0,
        dismissCalls: 0,
        killCalls: 0,
        async getGameflowPhase() {
            return lcu.phase;
        },
        async reconnectGame() {
            lcu.reconnectCalls++;
            if (options.reconnectShouldFail || failCount-- > 0) {
                throw new Error('reconnect failed');
            }
            return {};
        },
        async dismissEndOfGameStats() {
            lcu.dismissCalls++;
            return {};
        },
        async killGameProcess() {
            lcu.killCalls++;
            return true;
        },
    };
    return lcu;
}

describe('GameflowRecovery', () => {
    it('readPhase 返回当前阶段', async () => {
        const lcu = createFakeLcu();
        lcu.phase = 'Reconnect';
        const recovery = new GameflowRecovery({ lcu, logger: silentLogger });
        await expect(recovery.readPhase()).resolves.toBe('Reconnect');
    });

    it('LCU 查询失败时 readPhase 返回 undefined，不抛异常', async () => {
        const lcu = createFakeLcu();
        lcu.getGameflowPhase = vi.fn(async () => {
            throw new Error('500');
        });
        const recovery = new GameflowRecovery({ lcu, logger: silentLogger });
        await expect(recovery.readPhase()).resolves.toBeUndefined();
    });

    it('阶段分类助手正确识别异常/结束/大厅阶段', () => {
        expect(GameflowRecovery.isAbnormalPhase('Reconnect')).toBe(true);
        expect(GameflowRecovery.isAbnormalPhase('FailedToLaunch')).toBe(true);
        expect(GameflowRecovery.isAbnormalPhase('InProgress')).toBe(false);
        expect(GameflowRecovery.isEndPhase('WaitingForStats')).toBe(true);
        expect(GameflowRecovery.isEndPhase('PreEndOfGame')).toBe(true);
        expect(GameflowRecovery.isEndPhase('EndOfGame')).toBe(true);
        expect(GameflowRecovery.isEndPhase('InProgress')).toBe(false);
        expect(GameflowRecovery.isLobbyPhase('None')).toBe(true);
        expect(GameflowRecovery.isLobbyPhase('Lobby')).toBe(true);
        expect(GameflowRecovery.isLobbyPhase('InProgress')).toBe(false);
    });

    it('并发调用 reconnect 只发送一次请求（防重复）', async () => {
        const lcu = createFakeLcu();
        const recovery = new GameflowRecovery({ lcu, logger: silentLogger });
        await Promise.all([
            recovery.reconnect('并发A'),
            recovery.reconnect('并发B'),
        ]);
        expect(lcu.reconnectCalls).toBe(1);
    });

    it('冷却窗口内的重复 reconnect 会被忽略', async () => {
        const lcu = createFakeLcu();
        const clock = createFakeClock();
        const recovery = new GameflowRecovery({ lcu, logger: silentLogger, clock, reconnectCooldownMs: 2000 });

        await recovery.reconnect('第一次');
        clock.advance(500);
        await recovery.reconnect('第二次');
        expect(lcu.reconnectCalls).toBe(1);

        clock.advance(2000);
        await recovery.reconnect('第三次');
        expect(lcu.reconnectCalls).toBe(2);
    });

    it('reconnectWithRetries：失败两次后第三次成功', async () => {
        const lcu = createFakeLcu({ failFirstNReconnects: 2 });
        const clock = createFakeClock();
        const recovery = new GameflowRecovery({
            lcu,
            logger: silentLogger,
            clock,
            maxReconnectAttempts: 3,
            reconnectIntervalMs: 5000,
        });

        const ok = await recovery.reconnectWithRetries('测试');
        expect(ok).toBe(true);
        expect(lcu.reconnectCalls).toBe(3);
        expect(lcu.killCalls).toBe(0);
        expect(recovery.attempts).toBe(3);
    });

    it('reconnectWithRetries：全部失败后执行 kill + 最终重连', async () => {
        const lcu = createFakeLcu({ reconnectShouldFail: true });
        const clock = createFakeClock();
        const recovery = new GameflowRecovery({
            lcu,
            logger: silentLogger,
            clock,
            maxReconnectAttempts: 3,
            reconnectIntervalMs: 5000,
        });

        const ok = await recovery.reconnectWithRetries('始终失败');
        expect(ok).toBe(false);
        // 3 次常规尝试 + 1 次最终兜底
        expect(lcu.reconnectCalls).toBe(4);
        expect(lcu.killCalls).toBe(1);
    });

    it('reconnectWithRetries：abort 后立即停止', async () => {
        const lcu = createFakeLcu();
        const clock = createFakeClock();
        const recovery = new GameflowRecovery({ lcu, logger: silentLogger, clock });

        const controller = new AbortController();
        controller.abort();
        const ok = await recovery.reconnectWithRetries('已取消', controller.signal);
        expect(ok).toBe(false);
        expect(lcu.reconnectCalls).toBe(0);
    });

    it('dismissStats 防重复：并发只调用一次，冷却窗口内忽略', async () => {
        const lcu = createFakeLcu();
        const clock = createFakeClock();
        const recovery = new GameflowRecovery({ lcu, logger: silentLogger, clock, dismissCooldownMs: 2000 });

        await Promise.all([recovery.dismissStats('A'), recovery.dismissStats('B')]);
        expect(lcu.dismissCalls).toBe(1);

        clock.advance(500);
        await recovery.dismissStats('C');
        expect(lcu.dismissCalls).toBe(1);

        clock.advance(3000);
        await recovery.dismissStats('D');
        expect(lcu.dismissCalls).toBe(2);
    });

    it('dismissStats 失败时返回 false 且不抛出', async () => {
        const lcu = createFakeLcu();
        lcu.dismissEndOfGameStats = vi.fn(async () => {
            throw new Error('dismiss failed');
        });
        const recovery = new GameflowRecovery({ lcu, logger: silentLogger });
        await expect(recovery.dismissStats('测试')).resolves.toBe(false);
    });

    it('resetAttempts 清零重连次数', async () => {
        const lcu = createFakeLcu();
        const clock = createFakeClock();
        const recovery = new GameflowRecovery({ lcu, logger: silentLogger, clock });
        await recovery.reconnectWithRetries('测试');
        expect(recovery.attempts).toBe(1);
        recovery.resetAttempts();
        expect(recovery.attempts).toBe(0);
    });
});
