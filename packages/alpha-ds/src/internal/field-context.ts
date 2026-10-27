/**
 * Field context — lets a control (Input, Textarea, Checkbox, Switch, Select…) pick up its id,
 * label association, description/error wiring, disabled and invalid state from an enclosing
 * `Field.Root`, the way Base UI's Field does. Controls work standalone when there is no field.
 */
import { getContext, setContext } from 'svelte';

export interface FieldContext {
	readonly controlId: string;
	readonly descriptionId: string;
	readonly errorId: string;
	readonly disabled: boolean;
	readonly invalid: boolean;
	readonly hasDescription: boolean;
	readonly hasError: boolean;
	registerDescription(): () => void;
	registerError(): () => void;
}

const KEY = Symbol('alpha-ds.field');

export const setFieldContext = (ctx: FieldContext) => setContext(KEY, ctx);
export const getFieldContext = () => getContext<FieldContext | undefined>(KEY);

/** aria/id props a control should spread when inside a Field. */
export function fieldControlProps(field: FieldContext | undefined, own: { id?: string | null }) {
	if (!field) return {};
	const describedBy = [field.hasDescription && field.descriptionId, field.hasError && field.errorId]
		.filter(Boolean)
		.join(' ');
	return {
		id: own.id ?? field.controlId,
		'aria-describedby': describedBy || undefined,
		'aria-invalid': field.invalid || undefined,
		'data-invalid': field.invalid ? '' : undefined,
		disabled: field.disabled || undefined
	};
}
