/** Expression evaluation shared by the editor and unattended formula player. */
class PtixyEvaluator {
    constructor(columns, rows) {
        this.columns = columns;
        this.rows = rows;
        this.previous = null;
    }

    compile(source) {
        if (!source.trim()) throw new SyntaxError('Enter an expression.');
        // Preserve identifiers/array syntax and permit a trailing // comment.
        return new Function('x', 'y', 'i', 't', 'P', `"use strict"; return (\n${source}\n);`);
    }

    static errorMessage(error) {
        try {
            const message = error && typeof error.message === 'string'
                ? `${error.name || 'Error'}: ${error.message}` : String(error);
            return message.slice(0, 200);
        } catch {
            return 'Expression failed.';
        }
    }

    /** Retain getP(i) compatibility, including zero outside the grid. */
    getP(i, pixels) {
        if (!Number.isInteger(i) || i < 0 || i >= this.columns * this.rows) return 0;
        return (this.previous || pixels)[i];
    }

    evaluate(f, t, previous) {
        // All cells see one protected snapshot, even when a formula tries to write P.
        const P = new Proxy(Object.freeze(previous.slice()), {
            get(target, property, receiver) {
                if (typeof property === 'string' && /^-?\d+$/.test(property)) {
                    return target[property] === undefined ? 0 : target[property];
                }
                return Reflect.get(target, property, receiver);
            }
        });
        const next = Array(this.columns * this.rows);
        this.previous = P;
        try {
            // Preserve the original column-first order for random/noise expressions.
            for (let x = 0; x < this.columns; x++) {
                for (let y = 0; y < this.rows; y++) {
                    const i = x + y * this.columns;
                    try {
                        const value = f(x, y, i, t, P);
                        if (value && typeof value.then === 'function') {
                            Promise.resolve(value).catch(() => {});
                            throw new TypeError('Async expressions are not supported.');
                        }
                        if (typeof value !== 'number' && typeof value !== 'boolean') {
                            throw new TypeError('Expression must return a number or boolean.');
                        }
                        // Match JS comparison semantics: NaN is off, +Infinity is on.
                        next[i] = value > 0 ? 1 : 0;
                    } catch (error) {
                        throw new Error(`${PtixyEvaluator.errorMessage(error)} (x=${x}, y=${y}, i=${i}, t=${t})`);
                    }
                }
            }
        } finally {
            this.previous = null;
        }
        // A failed cell throws before returning: callers can only commit whole frames.
        return next;
    }
}
