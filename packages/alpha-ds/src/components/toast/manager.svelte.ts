/**
 * Base UI's toast model: a manager you `add()` to from anywhere, a Provider that exposes it, and a
 * Viewport that renders what it holds. `toastManager` is the app-wide instance; create more with
 * `createToastManager()` for isolated regions (tests, the docs page).
 */
import { getContext, setContext } from 'svelte';

export type ToastType = 'default' | 'success' | 'error' | 'loading';

export interface ToastOptions {
	title?: string;
	description?: string;
	type?: ToastType;
	/** ms before auto-dismiss; 0 keeps it until closed. Default 5000 (errors 10000). */
	timeout?: number;
	action?: { label: string; onClick: () => void };
	id?: string;
	/** Runs when the person dismisses it (close button, Escape), not when it times out or is closed in code. */
	onDismiss?: () => void;
	/** `data-testid` on the toast, for specs that read one toast in particular. */
	testId?: string;
}

export interface ToastItem extends Required<Pick<ToastOptions, 'type' | 'timeout'>> {
	id: string;
	title?: string;
	description?: string;
	action?: ToastOptions['action'];
	onDismiss?: () => void;
	testId?: string;
}

export class ToastManager {
	toasts = $state<ToastItem[]>([]);
	// Timer handles are bookkeeping, never rendered — a plain Map is correct, reactivity would be waste.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	#timers = new Map<string, ReturnType<typeof setTimeout>>();
	// When each running timer ends, so a pause can resume with only the time that was left.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	#ends = new Map<string, number>();
	#paused = false;
	#seq = 0;

	add(options: ToastOptions): string {
		const id = options.id ?? `toast-${++this.#seq}`;
		const type = options.type ?? 'default';
		const timeout = options.timeout ?? (type === 'error' ? 10000 : type === 'loading' ? 0 : 5000);
		const item: ToastItem = {
			id,
			type,
			timeout,
			title: options.title,
			description: options.description,
			action: options.action,
			onDismiss: options.onDismiss,
			testId: options.testId
		};
		const existing = this.toasts.findIndex((t) => t.id === id);
		if (existing >= 0) this.toasts[existing] = item;
		else this.toasts = [...this.toasts, item];
		this.#schedule(item);
		return id;
	}

	update(id: string, options: Omit<ToastOptions, 'id'>): void {
		const current = this.toasts.find((t) => t.id === id);
		if (current) this.add({ ...current, ...options, id });
	}

	close(id: string): void {
		clearTimeout(this.#timers.get(id));
		this.#timers.delete(id);
		this.#ends.delete(id);
		this.toasts = this.toasts.filter((t) => t.id !== id);
	}

	/** The person closed it (close button, Escape): runs its `onDismiss`, then closes it. */
	dismiss(id: string): void {
		this.toasts.find((t) => t.id === id)?.onDismiss?.();
		this.close(id);
	}

	/** Holds every timer while the person is reading (pointer over or focus in the stack). */
	pause(): void {
		if (this.#paused) return;
		this.#paused = true;
		for (const [id, timer] of this.#timers) {
			clearTimeout(timer);
			this.#timers.delete(id);
			this.#ends.set(id, Math.max(0, (this.#ends.get(id) ?? Date.now()) - Date.now()));
		}
	}

	/** Restarts the held timers with the time each had left. */
	resume(): void {
		if (!this.#paused) return;
		this.#paused = false;
		for (const [id, left] of this.#ends) this.#start(id, Math.max(left, 1000));
	}

	/** Resolve a promise into loading → success/error toasts (Base UI `promise`). */
	async promise<T>(
		work: Promise<T>,
		messages: {
			loading: string;
			success: string | ((v: T) => string);
			error: string | ((e: unknown) => string);
		}
	): Promise<T> {
		const id = this.add({ title: messages.loading, type: 'loading' });
		try {
			const value = await work;
			this.update(id, {
				title: typeof messages.success === 'function' ? messages.success(value) : messages.success,
				type: 'success',
				timeout: 5000
			});
			return value;
		} catch (err) {
			this.update(id, {
				title: typeof messages.error === 'function' ? messages.error(err) : messages.error,
				type: 'error',
				timeout: 10000
			});
			throw err;
		}
	}

	#schedule(item: ToastItem) {
		clearTimeout(this.#timers.get(item.id));
		this.#timers.delete(item.id);
		this.#ends.delete(item.id);
		if (item.timeout <= 0) return;
		if (this.#paused) this.#ends.set(item.id, item.timeout);
		else this.#start(item.id, item.timeout);
	}

	#start(id: string, ms: number) {
		this.#ends.set(id, Date.now() + ms);
		this.#timers.set(
			id,
			setTimeout(() => this.close(id), ms)
		);
	}
}

export const createToastManager = () => new ToastManager();

/** App-wide manager. */
export const toastManager = createToastManager();

const KEY = Symbol('alpha-ds.toast');
export const setToastManager = (m: ToastManager) => setContext(KEY, m);
/** Base UI `useToastManager()`: the nearest Provider's manager, else the app-wide one. */
export const useToastManager = (): ToastManager =>
	getContext<ToastManager | undefined>(KEY) ?? toastManager;
