import { Schedule } from 'effect';

export interface ExponentialRetryOptions {
	readonly initialDelayMs: number;
	readonly maxRetries: number;
	readonly factor?: number;
	readonly jitter?: boolean;
}

export const makeExponentialRetrySchedule = (options: ExponentialRetryOptions) => {
	const schedule = Schedule.exponential(`${options.initialDelayMs} millis`, options.factor ?? 2);
	const jittered = options.jitter === false ? schedule : schedule.pipe(Schedule.jittered);
	return jittered.pipe(Schedule.both(Schedule.recurs(options.maxRetries)));
};

export const makeSpacedRetrySchedule = (delayMs: number, maxRetries: number) =>
	Schedule.spaced(`${delayMs} millis`).pipe(Schedule.both(Schedule.recurs(maxRetries)));
