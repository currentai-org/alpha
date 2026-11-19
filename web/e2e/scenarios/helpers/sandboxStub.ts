// What the sandbox stand-in specs send and expect (web/src/lib/chat/server/mcp/sandboxWaitStub.ts).

/** What the stand-in's run_code prints, whatever code it is given (SANDBOX_WAIT_STUB_STDOUT): 2 to the 43. */
export const STUB_STDOUT = '8796093022208';

/**
 * A request only a code run can serve. Large 4 is offered the calculator beside run_code, and asked for
 * a sum it answers with the calculator, so the stand-in is never called. The length of the
 * sentence is 43, so a real run prints STUB_STDOUT too and the stand-in's answer reads as the true one.
 */
export const RUN_CODE_PROMPT =
	"Run this Python with your run_code tool and tell me exactly what it printed: print(1 << len('the quick brown fox jumps over the lazy dog'))";

/** X-ray's step for a turn that used the calculator. */
export const CALCULATOR_STEP = '[data-step-id="calculator"]';

/** The failure message when the model answered with the calculator instead of calling run_code. */
export const ANSWERED_BY_CALCULATOR =
	'the model answered with the calculator, so the stand-in sandbox was never called: the prompt must ask for something only a code run can do (CUR-5022)';
