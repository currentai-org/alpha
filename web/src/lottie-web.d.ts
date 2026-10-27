// lottie-web's ESM light build (SVG renderer, no expressions) ships no type declarations of its own.
// Its default export is the same player the package's main entry types as `LottiePlayer`. The UMD
// file at build/player/lottie_light.js imports as an empty module under Vite, so the ESM file is
// the one to import.
declare module 'lottie-web/build/player/esm/lottie_light.min.js' {
	import type { LottiePlayer } from 'lottie-web';
	const lottie: LottiePlayer;
	export default lottie;
}
