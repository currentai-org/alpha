/**
 * Whether the welcome is on screen. While it is, the welcome shows the current error as a line
 * in its own column and the floating toast stays down, since the toast landed on the intro's
 * paragraph (CUR-2883).
 */
class WelcomeOnScreenStore {
	open = $state(false);
}

export const welcomeOnScreen = new WelcomeOnScreenStore();
