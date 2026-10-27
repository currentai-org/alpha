import type { Message } from "$lib/chat/types/Message";
import Handlebars from "handlebars";
import { Template } from "@huggingface/jinja";
import { logger } from "$lib/chat/server/logger";

// Register Handlebars helpers
Handlebars.registerHelper("ifUser", function (this: Pick<Message, "from" | "content">, options) {
	if (this.from == "user") return options.fn(this);
});

Handlebars.registerHelper(
	"ifAssistant",
	function (this: Pick<Message, "from" | "content">, options) {
		if (this.from == "assistant") return options.fn(this);
	}
);

// Tries Jinja and falls back to Handlebars if Jinja fails
export function compileTemplate<T>(
	input: string,
	model: { preprompt: string; templateEngine?: string }
) {
	let jinjaTemplate: Template | undefined;
	try {
		// Try to compile with Jinja
		jinjaTemplate = new Template(input);
	} catch {
		// Could not compile with Jinja
		jinjaTemplate = undefined;
	}

	const hbTemplate = Handlebars.compile<T>(input, {
		knownHelpers: { ifUser: true, ifAssistant: true },
		knownHelpersOnly: true,
		noEscape: true,
		strict: true,
		preventIndent: true,
	});

	return function render(inputs: T) {
		if (jinjaTemplate) {
			try {
				return jinjaTemplate.render({ ...model, ...inputs });
			} catch (e) {
				logger.error(e, "Could not render with Jinja");
				// Fallback to Handlebars if Jinja rendering fails
				return hbTemplate({ ...model, ...inputs });
			}
		}
		return hbTemplate({ ...model, ...inputs });
	};
}
