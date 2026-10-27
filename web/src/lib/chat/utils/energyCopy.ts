// The session meter's elapsed time and LED-bulb comparison, in the interface language.
import { m } from '$lib/paraglide/messages.js';
import { ENERGY_ANCHORS, energyAnchor } from './energyEstimate';

export function localizedElapsed(ms: number): string {
	const totalMinutes = Math.floor(Math.max(0, ms) / 60_000);
	if (totalMinutes < 1) return m.chat_elapsedUnderMinute();
	if (totalMinutes < 60) return m.chat_elapsedMinutes({ minutes: totalMinutes });
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return minutes === 0
		? m.chat_elapsedHours({ hours })
		: m.chat_elapsedHoursMinutes({ hours, minutes });
}

/** How long a 10-watt LED bulb runs on `wh`: one relatable comparison beside the estimate, which
 *  stacks a second approximation on the first, so the tooltip owns that caveat. */
export function localizedComparison(wh: number): string {
	const seconds = (wh / 10) * 3600;
	if (seconds < 90) return m.chat_energyBulbSeconds({ seconds: Math.max(1, Math.round(seconds)) });
	const minutes = seconds / 60;
	if (minutes < 90) return m.chat_energyBulbMinutes({ minutes: Math.round(minutes) });
	return m.chat_energyBulbHours({ hours: (minutes / 60).toFixed(1) });
}

/** The same bulb comparison, short enough for the footprint trigger: "a light bulb for 3 s". */
export function localizedBulbShort(wh: number): string {
	const seconds = (wh / 10) * 3600;
	if (seconds < 90) return m.chat_footprintBulbSeconds({ seconds: Math.max(1, Math.round(seconds)) });
	const minutes = seconds / 60;
	if (minutes < 90) return m.chat_footprintBulbMinutes({ minutes: Math.round(minutes) });
	return m.chat_footprintBulbHours({ hours: (minutes / 60).toFixed(1) });
}

export function localizedAnchor(wh: number): { wh: number; label: string; short: string } {
	const anchorFor = energyAnchor(wh);
	const [phone, laptop, kettle] = ENERGY_ANCHORS;
	if (anchorFor.wh === phone.wh)
		return { wh: anchorFor.wh, label: m.chat_anchorPhone(), short: m.chat_anchorPhoneShort() };
	if (anchorFor.wh === laptop.wh)
		return { wh: anchorFor.wh, label: m.chat_anchorLaptop(), short: m.chat_anchorLaptopShort() };
	if (anchorFor.wh === kettle.wh)
		return { wh: anchorFor.wh, label: m.chat_anchorKettle(), short: m.chat_anchorKettleShort() };
	const count = anchorFor.wh / kettle.wh;
	return {
		wh: anchorFor.wh,
		label: m.chat_anchorKettles({ count }),
		short: m.chat_anchorKettlesShort({ count })
	};
}
