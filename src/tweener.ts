import { ShellWindow } from "./window";

const GLib: GLib = imports.gi.GLib;
const { Clutter } = imports.gi;

export interface TweenParams {
    x: number;
    y: number;
    duration: number;
    mode: any | null;
    onComplete?: () => void;
}

export function add(w: ShellWindow, p: TweenParams) {
    if (!p.mode) p.mode = Clutter.AnimationMode.LINEAR;
    let a = w.meta.get_compositor_private();
    if (a) {
        w.hide_border();
        remove(a);
        a.ease(p);
    }
}

export function remove(a: Clutter.Actor) {
    a.remove_all_transitions();
}

export function is_tweening(a: Clutter.Actor) {
    return a.get_transition('x')
        || a.get_transition('y')
        || a.get_transition('scale-x')
        || a.get_transition('scale-y');
}

export function on_window_tweened(win: ShellWindow, callback: () => void): SignalID {
    return GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
        const actor = win.meta.get_compositor_private();
        if (actor) { 
            if (is_tweening(actor)) {
                win.hide_border();
                return true
            } else {
                remove(actor);
                callback();
            }
        }
        return false;
    });
}
