// @ts-ignore
const Me = imports.misc.extensionUtils.getCurrentExtension();

// import * as Ecs from 'ecs';
import * as GrabOp from 'grab_op';
import * as Lib from 'lib';
import * as Log from 'log';
import * as Node from 'node';
import * as Rect from 'rectangle';
import * as shell from 'shell';
import * as Tags from 'tags';
import * as Tweener from 'tweener';
import * as window from 'window';

import type { Entity } from './ecs';
import type { Rectangle } from './rectangle';
import type { Ext } from './extension';
import type { NodeStack } from './node';
import { AutoTiler } from './auto_tiler';
import { Fork } from './fork';

const { Meta } = imports.gi;
const Main = imports.ui.main;
const { ShellWindow } = window;

enum Direction {
    Left,
    Up,
    Right,
    Down
}

export class Tiler {
    private keybindings: Object;

    private window: Entity | null = null;
    private swap_window: Entity | null = null;

    constructor(ext: Ext) {
        this.keybindings = {
            "management-orientation": () => {
                if (ext.auto_tiler && this.window) {
                    const window = ext.windows.get(this.window);
                    if (window) {
                        ext.auto_tiler.toggle_orientation(ext);
                        ext.set_overlay(window.rect());
                    }
                }
            },

            "tile-move-left": () => this.move_left(ext),
            "tile-move-down": () => this.move_down(ext),
            "tile-move-up": () => this.move_up(ext),
            "tile-move-right": () => this.move_right(ext),
            "tile-resize-left": () => this.resize(ext, Direction.Left),
            "tile-resize-down": () => this.resize(ext, Direction.Down),
            "tile-resize-up": () => this.resize(ext, Direction.Up),
            "tile-resize-right": () => this.resize(ext, Direction.Right),
            "tile-swap-left": () => this.swap_left(ext),
            "tile-swap-down": () => this.swap_down(ext),
            "tile-swap-up": () => this.swap_up(ext),
            "tile-swap-right": () => this.swap_right(ext),
            "tile-accept": () => this.accept(ext),
            "tile-reject": () => this.exit(ext),
            "toggle-stacking": () => {
                ext.auto_tiler?.toggle_stacking(ext);
                const win = ext.focus_window();
                if (win) this.overlay_watch(ext, win);
            },
        };
    }

    rect(ext: Ext, monitor: Rectangle): Rectangle | null {
        if (!ext.overlay.visible) return null;

        const columns = monitor.width / ext.column_size;
        const rows = monitor.height / ext.row_size;

        return monitor_rect(monitor, columns, rows);
    }

    change(overlay: Rectangular, rect: Rectangle, dx: number, dy: number, dw: number, dh: number): Tiler {
        let changed = new Rect.Rectangle([
            overlay.x + dx * rect.width,
            overlay.y + dy * rect.height,
            overlay.width + dw * rect.width,
            overlay.height + dh * rect.height,
        ]);

        // Align to grid
        changed.x = Lib.round_increment(changed.x - rect.x, rect.width) + rect.x;
        changed.y = Lib.round_increment(changed.y - rect.y, rect.height) + rect.y;
        changed.width = Lib.round_increment(changed.width, rect.width);
        changed.height = Lib.round_increment(changed.height, rect.height);

        // Ensure that width is not too small
        if (changed.width < rect.width) {
            changed.width = rect.width;
        }

        // Ensure that height is not too small
        if (changed.height < rect.height) {
            changed.height = rect.height;
        }

        // Check that corrected rectangle fits on monitors
        let monitors = tile_monitors(changed);

        // Do not use change if there are no matching displays
        if (monitors.length == 0) return this;

        let min_x: number | null = null;
        let min_y: number | null = null;
        let max_x: number | null = null;
        let max_y: number | null = null;

        for (const monitor of monitors) {
            if (min_x === null || monitor.x < min_x) {
                min_x = monitor.x;
            }
            if (min_y === null || monitor.y < min_y) {
                min_y = monitor.y;
            }
            if (max_x === null || (monitor.x + monitor.width) > max_x) {
                max_x = monitor.x + monitor.width;
            }
            if (max_y === null || (monitor.y + monitor.height) < max_y) {
                max_y = monitor.y + monitor.height;
            }
        }

        if (
            // Do not use change if maxima cannot be found
            (min_x === null || min_y === null || max_x === null || max_y === null)
            // Prevent moving too far left
            || changed.x < min_x
            // Prevent moving too far right
            || (changed.x + changed.width) > max_x
            // Prevent moving too far up
            || changed.y < min_y
            // Prevent moving too far down
            || (changed.y + changed.height) > max_y
        ) return this;

        overlay.x = changed.x;
        overlay.y = changed.y;
        overlay.width = changed.width;
        overlay.height = changed.height;

        return this;
    }

    unstack_from_fork(ext: Ext, stack: NodeStack, focused: window.ShellWindow, fork: Fork, left: Node.Node, right: Node.Node, is_left: boolean) {
        if (!ext.auto_tiler) return;

        const forest = ext.auto_tiler.forest;
        const new_fork = forest.create_fork(
            left,
            right,
            fork.area,
            fork.workspace
        );

        if (is_left) {
            fork.left = Node.Node.fork(new_fork[0]);
        } else {
            fork.right = Node.Node.fork(new_fork[0]);
        }

        // Update parent assignments
        forest.on_attach(new_fork[0], focused.entity);
        for (const e of stack.entities) {
            forest.on_attach(new_fork[0], e);
        }
    }

    move(ext: Ext, x: number, y: number, w: number, h: number, direction: Direction, focus: () => window.ShellWindow | number | null) {
        if (!this.window) return;
        if (ext.auto_tiler && !ext.contains_tag(this.window, Tags.Floating)) {
            const focused = ext.focus_window();
            if (focused) {
                const move_to = focus();

                // Check if the focused window is in a stack first.
                if (ext.auto_tiler) {
                    const s = ext.auto_tiler.find_stack(focused.entity);
                    if (s) {
                        const [fork, branch, is_left] = s;
                        const stack = branch.inner as NodeStack;

                        if (stack.entities.length === 1) {
                            ext.auto_tiler.toggle_stacking(ext);
                            this.overlay_watch(ext, focused);
                            return;
                        }

                        switch (direction) {
                            // Move focused window in stack to the left
                            case Direction.Left:
                                if (!Node.stack_move_left(ext, ext.auto_tiler.forest, stack, focused.entity)) {
                                    focused.stack = null;

                                    // No window existed to the left of the stack. Detach and modify the tree.
                                    if (fork.right === null) {
                                        fork.right = fork.left;
                                        fork.left = Node.Node.window(focused.entity);
                                    } else {
                                        this.unstack_from_fork(
                                            ext,
                                            stack,
                                            focused,
                                            fork,
                                            Node.Node.window(focused.entity),
                                            branch,
                                            is_left
                                        );
                                    }

                                    ext.auto_tiler.tile(ext, fork, fork.area);
                                    this.overlay_watch(ext, focused);
                                }

                                ext.auto_tiler.update_stack(ext, stack);

                                return;
                            // Move focused window in stack to the right
                            case Direction.Right:
                                if (!Node.stack_move_right(ext, ext.auto_tiler.forest, stack, focused.entity)) {
                                    focused.stack = null;
                                    if (fork.right) {
                                        this.unstack_from_fork(
                                            ext,
                                            stack,
                                            focused,
                                            fork,
                                            branch,
                                            Node.Node.window(focused.entity),
                                            is_left
                                        );
                                    } else {
                                        fork.right = Node.Node.window(focused.entity);
                                    }

                                    ext.auto_tiler.tile(ext, fork, fork.area);
                                    this.overlay_watch(ext, focused);
                                }

                                ext.auto_tiler.update_stack(ext, stack);

                                return;
                        }
                    }
                }

                if (move_to !== null) this.move_auto(ext, focused, move_to, direction === Direction.Left);
            }
        } else {
            this.swap_window = null;
            this.rect_by_active_area(ext, (_monitor, rect) => {
                this.change(ext.overlay, rect, x, y, w, h)
                    .change(ext.overlay, rect, 0, 0, 0, 0);
            });
        }
    }

    move_auto_(ext: Ext, mov1: Rectangle, mov2: Rectangle, callback: (m: Rectangle, a: Rectangle, mov: Rectangle) => boolean) {
        if (ext.auto_tiler && this.window) {
            const entity = ext.auto_tiler.attached.get(this.window);
            if (entity) {
                const fork = ext.auto_tiler.forest.forks.get(entity);
                const window = ext.windows.get(this.window);

                if (!fork || !window) return;

                const workspace_id = ext.workspace_id(window);

                const toplevel = ext.auto_tiler.forest.find_toplevel(workspace_id);

                if (!toplevel) return;

                const topfork = ext.auto_tiler.forest.forks.get(toplevel);

                if (!topfork) return;

                const toparea = topfork.area as Rect.Rectangle;

                const before = window.rect();

                const grab_op = new GrabOp.GrabOp((this.window as Entity), before);

                let crect = grab_op.rect.clone();

                // TODO: This is a hack. Find a better solution.
                let fix_diff = () => {
                    let diff = before.diff(crect);

                    diff.width -= diff.width % 64;
                    diff.height -= diff.height % 64;

                    if (diff.width > 64) {
                        diff.width = (diff.width - 64) * -1;
                    } else if (diff.width < -64) {
                        diff.width = (diff.width + 64) * -1;
                    }

                    if (diff.height > 64) {
                        diff.height = (diff.height - 64) * -1;
                    } else if (diff.height < -64) {
                        diff.height = (diff.height + 64) * -1;
                    }

                    let tmp = before.clone();
                    tmp.apply(diff);
                    crect = tmp;
                };

                let resize = (mov: Rectangle, func: (m: Rectangle, a: Rectangle, mov: Rectangle) => boolean) => {
                    if (func(toparea, crect, mov) || crect.eq(grab_op.rect)) return;

                    fix_diff();

                    (ext.auto_tiler as AutoTiler).forest.resize(ext, entity, fork, (this.window as Entity), grab_op.operation(crect), crect);
                    grab_op.rect = crect.clone();
                };

                resize(mov1, callback);
                resize(mov2, callback);

                ext.auto_tiler.forest.arrange(ext, fork.workspace);

                Tweener.on_window_tweened(window.meta, () => {
                    ext.register_fn(() => ext.set_overlay(window.rect()));
                });
            }
        }
    }

    overlay_watch(ext: Ext, window: window.ShellWindow) {
        Tweener.on_window_tweened(window.meta, () => {
            ext.register_fn(() => {
                if (window) {
                    ext.set_overlay(window.rect());
                    window.meta.raise();
                    window.meta.unminimize();
                    window.meta.activate(global.get_current_time());
                }
            });
        });
    }

    rect_by_active_area(ext: Ext, callback: (monitor: Rectangle, area: Rectangle) => void) {
        if (this.window) {
            const monitor_id = ext.monitors.get(this.window);
            if (monitor_id) {
                const monitor = ext.monitor_work_area(monitor_id[0]);
                let rect = this.rect(ext, monitor);

                if (rect) {
                    callback(monitor, rect)
                }
            }
        }
    }

    resize_auto(ext: Ext, direction: Direction) {
        let mov1: [number, number, number, number], mov2: [number, number, number, number];

        const hrow = 64;
        const hcolumn = 64;

        switch (direction) {
            case Direction.Left:
                mov1 = [hrow, 0, -hrow, 0];
                mov2 = [0, 0, -hrow, 0];
                break;
            case Direction.Right:
                mov1 = [0, 0, hrow, 0];
                mov2 = [-hrow, 0, hrow, 0];
                break;
            case Direction.Up:
                mov1 = [0, hcolumn, 0, -hcolumn];
                mov2 = [0, 0, 0, -hcolumn];
                break;
            default:
                mov1 = [0, 0, 0, hcolumn];
                mov2 = [0, -hcolumn, 0, hcolumn];
        }

        this.move_auto_(
            ext,
            new Rect.Rectangle(mov1),
            new Rect.Rectangle(mov2),
            (work_area, crect, mov) => {
                crect.apply(mov);
                crect.clamp(work_area);

                return false;
            },
        );
    }

    move_auto(ext: Ext, focused: window.ShellWindow, move_to: window.ShellWindow | number, stack_from_left: boolean = true) {
        let watching: null | window.ShellWindow = null;

        if (ext.auto_tiler) {
            if (move_to instanceof ShellWindow) {
                // Check if we are moving onto a stack, and if so, move into the stack.
                const stack_info = ext.auto_tiler.find_stack(move_to.entity);
                if (stack_info) {
                    const [stack_fork, branch,] = stack_info;
                    const stack = branch.inner as NodeStack;

                    ext.auto_tiler.detach_window(ext, focused.entity);

                    ext.auto_tiler.forest.on_attach(stack_fork.entity, focused.entity);
                    ext.auto_tiler.update_stack(ext, stack);

                    ext.auto_tiler.tile(ext, stack_fork, stack_fork.area);

                    ext.auto_tiler.detach_window(ext, focused.entity);
                    ext.auto_tiler.attach_to_window(ext, move_to, focused, Lib.cursor_rect(), stack_from_left);
                    watching = focused;
                } else {
                    const parent = ext.auto_tiler.windows_are_siblings(focused.entity, move_to.entity);
                    if (parent) {
                        const fork = ext.auto_tiler.forest.forks.get(parent);
                        if (fork) {
                            if (!fork.right) {
                                Log.error('move_auto: detected as sibling, but fork lacks right branch');
                                return;
                            }

                            if (fork.left.inner.kind === 3) {
                                Node.stack_remove(ext.auto_tiler.forest, fork.left.inner, focused.entity);
                                focused.stack = null;
                            } else {
                                const temp = fork.right;

                                fork.right = fork.left;
                                fork.left = temp;

                                ext.auto_tiler.tile(ext, fork, fork.area);
                                watching = focused;
                            }
                        }
                    }

                    if (!watching) {
                        ext.auto_tiler.detach_window(ext, focused.entity);
                        ext.auto_tiler.attach_to_window(ext, move_to, focused, Lib.cursor_rect());
                        watching = focused;
                    }
                }
            } else {
                ext.auto_tiler.detach_window(ext, focused.entity);
                ext.auto_tiler.attach_to_monitor(ext, focused, [move_to, ext.active_workspace()]);
                watching = focused;
            }
        }

        if (watching) {
            this.overlay_watch(ext, watching);
        } else {
            ext.set_overlay(focused.rect());
        }
    }

    move_left(ext: Ext) {
        this.move(ext, -1, 0, 0, 0, Direction.Left, move_window_or_monitor(
            ext,
            ext.focus_selector.left,
            Meta.DisplayDirection.LEFT
        ));
    }

    move_down(ext: Ext) {
        this.move(ext, 0, 1, 0, 0, Direction.Down, move_window_or_monitor(
            ext,
            ext.focus_selector.down,
            Meta.DisplayDirection.DOWN
        ));
    }

    move_up(ext: Ext) {
        this.move(ext, 0, -1, 0, 0, Direction.Up, move_window_or_monitor(
            ext,
            ext.focus_selector.up,
            Meta.DisplayDirection.UP
        ));
    }

    move_right(ext: Ext) {
        this.move(ext, 1, 0, 0, 0, Direction.Right, move_window_or_monitor(
            ext,
            ext.focus_selector.right,
            Meta.DisplayDirection.RIGHT
        ));
    }

    resize(ext: Ext, direction: Direction) {
        if (!this.window) return;

        if (ext.auto_tiler && !ext.contains_tag(this.window, Tags.Floating)) {
            this.resize_auto(ext, direction);
        } else {
            let array: [number, number, number, number];
            switch (direction) {
                case Direction.Down:
                    array = [0, 0, 0, 1];
                    break
                case Direction.Left:
                    array = [0, 0, -1, 0];
                    break
                case Direction.Up:
                    array = [0, 0, 0, -1];
                    break
                default:
                    array = [0, 0, 1, 0];
            }

            const [x, y, w, h] = array;

            this.swap_window = null;
            this.rect_by_active_area(ext, (_monitor, rect) => {
                this.change(ext.overlay, rect, x, y, w, h)
                    .change(ext.overlay, rect, 0, 0, 0, 0);
            });
        }
    }

    swap(ext: Ext, selector: window.ShellWindow | null) {
        if (selector) {
            ext.set_overlay(selector.rect());
            this.swap_window = selector.entity;
        }
    }

    swap_left(ext: Ext) {
        if (this.swap_window) {
            ext.windows.with(this.swap_window, (window) => {
                this.swap(ext, ext.focus_selector.left(ext, window));
            });
        } else {
            this.swap(ext, ext.focus_selector.left(ext, null));
        }
    }

    swap_down(ext: Ext) {
        if (this.swap_window) {
            ext.windows.with(this.swap_window, (window) => {
                this.swap(ext, ext.focus_selector.down(ext, window));
            });
        } else {
            this.swap(ext, ext.focus_selector.down(ext, null));
        }
    }

    swap_up(ext: Ext) {
        if (this.swap_window) {
            ext.windows.with(this.swap_window, (window) => {
                this.swap(ext, ext.focus_selector.up(ext, window));
            })
        } else {
            this.swap(ext, ext.focus_selector.up(ext, null));
        }
    }

    swap_right(ext: Ext) {
        if (this.swap_window) {
            ext.windows.with(this.swap_window, (window) => {
                this.swap(ext, ext.focus_selector.right(ext, window));
            });
        } else {
            this.swap(ext, ext.focus_selector.right(ext, null));
        }
    }

    enter(ext: Ext) {
        if (!this.window) {
            const win = ext.focus_window();
            if (!win) return;

            this.window = win.entity;

            if (win.is_maximized()) {
                win.meta.unmaximize(Meta.MaximizeFlags.BOTH);
            }

            // Set overlay to match window
            ext.set_overlay(win.rect());
            ext.overlay.visible = true;

            if (!ext.auto_tiler || ext.contains_tag(win.entity, Tags.Floating)) {
                // Make sure overlay is valid
                this.rect_by_active_area(ext, (_monitor, rect) => {
                    this.change(ext.overlay, rect, 0, 0, 0, 0);
                });
            }

            ext.keybindings.disable(ext.keybindings.window_focus)
                .enable(this.keybindings);
        }
    }

    accept(ext: Ext) {
        if (this.window) {
            const meta = ext.windows.get(this.window);
            if (meta) {
                if (this.swap_window) {
                    const meta_swap = ext.windows.get(this.swap_window);
                    if (meta_swap) {
                        if (ext.auto_tiler) {
                            ext.auto_tiler.attach_swap(this.swap_window, this.window);
                        }

                        ext.size_signals_block(meta);
                        ext.size_signals_block(meta_swap);

                        meta_swap.move(ext, meta.rect(), () => {
                            ext.size_signals_unblock(meta_swap);
                        });
                    }
                }

                const meta_entity = this.window;
                meta.move(ext, ext.overlay, () => {
                    ext.size_signals_unblock(meta);
                    ext.add_tag(meta_entity, Tags.Tiled);
                });
            }
        }

        this.swap_window = null;

        this.exit(ext);
    }

    exit(ext: Ext) {
        if (this.window) {
            this.window = null;

            // Disable overlay
            ext.overlay.visible = false;

            // Disable tiling keybindings
            ext.keybindings.disable(this.keybindings)
                .enable(ext.keybindings.window_focus);
        }
    }

    snap(ext: Ext, win: window.ShellWindow) {
        let mon_geom = ext.monitor_work_area(win.meta.get_monitor());
        if (mon_geom) {
            let rect = win.rect();
            const columns = mon_geom.width / ext.column_size;
            const rows = mon_geom.height / ext.row_size;
            this.change(
                rect,
                monitor_rect(mon_geom, columns, rows),
                0, 0, 0, 0
            );

            win.move(ext, rect);

            ext.snapped.insert(win.entity, true);
        }
    }
};

function locate_monitor(ext: Ext, direction: Meta.DisplayDirection): number | null {
    return shell.monitor_neighbor_index(ext.active_monitor(), direction);
}

function monitor_rect(monitor: Rectangle, columns: number, rows: number): Rectangle {
    let tile_width = monitor.width / columns;
    let tile_height = monitor.height / rows;

    // Anything above 21:9 is considered ultrawide
    if (monitor.width * 9 >= monitor.height * 21) {
        tile_width /= 2;
    }

    // Anything below 9:21 is probably a rotated ultrawide
    if (monitor.height * 9 >= monitor.width * 21) {
        tile_height /= 2;
    }

    return new Rect.Rectangle([monitor.x, monitor.y, tile_width, tile_height]);
}

function move_window_or_monitor(ext: Ext, method: any, direction: Meta.DisplayDirection): () => window.ShellWindow | number | null {
    return () => {
        const window = method.call(ext.focus_selector, ext, null);

        return window ?? locate_monitor(ext, direction);
    };
}

function tile_monitors(rect: Rectangle): Array<Rectangle> {
    let total_size = (a: Rectangle, b: Rectangle): number => (a.width * a.height) - (b.width * b.height);

    let workspace = global.workspace_manager.get_active_workspace();
    return Main.layoutManager.monitors
        .map((_monitor: Rectangle, i: number) => workspace.get_work_area_for_monitor(i))
        .filter((monitor: Rectangle) => {
            return (rect.x + rect.width) > monitor.x &&
                (rect.y + rect.height) > monitor.y &&
                rect.x < (monitor.x + monitor.width) &&
                rect.y < (monitor.y + monitor.height);
        })
        .sort(total_size);
}
