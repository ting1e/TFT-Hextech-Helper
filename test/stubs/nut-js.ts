/** @nut-tree-fork/nut-js 测试桩 */
export class Point {
    constructor(public x = 0, public y = 0) {}
}

export class Region {
    constructor(
        public left = 0,
        public top = 0,
        public width = 0,
        public height = 0,
    ) {}
}

export const screen = {
    width: async () => 1920,
    height: async () => 1080,
    grab: async () => ({ data: Buffer.alloc(0), width: 0, height: 0 }),
};

export const mouse = {
    setPosition: async () => undefined,
    click: async () => undefined,
    move: async () => undefined,
};

export const keyboard = {
    type: async () => undefined,
    pressKey: async () => undefined,
};

export const Button = { LEFT: 0, RIGHT: 1, MIDDLE: 2 };

export default { Point, Region, screen, mouse, keyboard, Button };
