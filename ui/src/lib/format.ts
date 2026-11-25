type RelativeTimeUnit = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

export function formatRelativeTime(value: string | number, now: number) {
	const timestamp = typeof value === 'number' ? value : Date.parse(value);
	if (!Number.isFinite(timestamp)) {
		return '';
	}

	const diffSeconds = Math.round((timestamp - now) / 1000);
	const absSeconds = Math.abs(diffSeconds);

	if (absSeconds < 60) {
		return 'τώρα';
	}

	if (absSeconds < 3_600) {
		return formatGreekRelativeUnit(Math.round(diffSeconds / 60), 'minute');
	}

	if (absSeconds < 86_400) {
		return formatGreekRelativeUnit(Math.round(diffSeconds / 3_600), 'hour');
	}

	if (absSeconds < 604_800) {
		return formatGreekRelativeUnit(Math.round(diffSeconds / 86_400), 'day');
	}

	if (absSeconds < 2_629_800) {
		return formatGreekRelativeUnit(Math.round(diffSeconds / 604_800), 'week');
	}

	if (absSeconds < 31_557_600) {
		return formatGreekRelativeUnit(Math.round(diffSeconds / 2_629_800), 'month');
	}

	return formatGreekRelativeUnit(Math.round(diffSeconds / 31_557_600), 'year');
}

export function formatAbsoluteDateTime(value: string | number, locale: string, timeZone?: string) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return '';
	}

	const options: Intl.DateTimeFormatOptions = {
		weekday: 'long',
		day: 'numeric',
		month: 'long',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23',
		timeZone
	};

	const formatter = new Intl.DateTimeFormat(locale, options);
	const formatted = formatter.format(date);

	if (!locale.startsWith('el')) {
		return formatted;
	}

	const hour = formatter.formatToParts(date).find((part) => part.type === 'hour')?.value;
	if (hour !== '01' && hour !== '13') {
		return formatted;
	}

	return formatted.replace(/στις(?=\s*\d{2}:)/u, 'στη');
}

export function formatNumber(value: number, locale: string) {
	return new Intl.NumberFormat(locale).format(value);
}

function formatGreekRelativeUnit(value: number, unit: RelativeTimeUnit) {
	const amount = Math.abs(value);
	return `${amount} ${getGreekRelativeUnitLabel(amount, unit)}`;
}

function getGreekRelativeUnitLabel(amount: number, unit: RelativeTimeUnit) {
	if (unit === 'minute') return amount === 1 ? 'λεπτό' : 'λεπτά';
	if (unit === 'hour') return amount === 1 ? 'ώρα' : 'ώρες';
	if (unit === 'day') return amount === 1 ? 'ημέρα' : 'ημέρες';
	if (unit === 'week') return amount === 1 ? 'εβδομάδα' : 'εβδομάδες';
	if (unit === 'month') return amount === 1 ? 'μήνας' : 'μήνες';
	return amount === 1 ? 'χρόνο' : 'χρόνια';
}
