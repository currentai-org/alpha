"""What an answer that made no tool call is: a refusal, a plain answer, or a claim of work nobody did (CUR-4599).

A spec-less agentic turn that called no tool is judged by what the reply says, not by that fact alone
(CUR-766). Retrying it, and putting "no tool call was observed" over it on the chat site, is right when the
agent narrated a run it never made (CUR-574) or wrote instructions for something it could have done itself
(CUR-766). It is wrong when the agent said, correctly, that it cannot send an email: re-asking a refusal
ends the task FAILED and the page doubts an answer that claimed nothing. Only the reply's meaning separates those, so a model
reads it, with the shape forced by a tool call.

Its own module, free of app.py's import-time setup, like auto_review.py."""
import json

# The verdicts an answer can get. ACCEPTED ones end the turn on this attempt and tell the site the missing
# tool calls are not a sign of overclaiming; the others are retried as before.
ACCEPTED = frozenset({"declined", "answered"})
VERDICTS = ("declined", "answered", "skipped", "narrated")

_NO_TOOL_REVIEW_SYSTEM = (
    "An AI agent was given a request and replied without using any of its tools: it ran no code and no "
    "command, and read, wrote or changed no file. Its tools can run code and shell commands and create, "
    "read and change files in a private folder. They cannot send email or messages, sign in to accounts, "
    "pay for things, or act on any device or service outside that folder.\n"
    "Pick the one verdict that fits the reply:\n"
    "- declined: it says it cannot or will not do the request, or the part of it that needs something its "
    "tools cannot do, and claims nothing done. It may tell the person how to do it themselves.\n"
    "- answered: the request needed no tool, and the reply answers it from general knowledge or from what "
    "the person wrote, claiming no file, run, measurement or check.\n"
    "- skipped: its tools could have done the request (making a file, running code, working out a result "
    "from data), but it handed the person code, text or instructions instead, or asked them to do it.\n"
    "- narrated: it says or implies it did something only a tool could do, such as saving or changing a "
    "file, running code or reporting a result such a step would produce, or promises to do it next.\n"
    "If a reply both declines and claims work done, the verdict is narrated."
)
_NO_TOOL_REVIEW_TOOL = {
    "type": "function",
    "function": {
        "name": "verdict",
        "description": "Which kind of reply this is.",
        "parameters": {
            "type": "object",
            "properties": {"verdict": {"type": "string", "enum": list(VERDICTS)}},
            "required": ["verdict"],
            "additionalProperties": False,
        },
    },
}


def review_body(request_text: str, reply: str, max_tokens: int) -> dict:
    """The chat-completions body (without `model`). The system block is identical on every call."""
    user = json.dumps({"request": request_text[:4000], "reply": reply[:6000]})
    return {"messages": [{"role": "system", "content": _NO_TOOL_REVIEW_SYSTEM},
                         {"role": "user", "content": user}],
            "tools": [_NO_TOOL_REVIEW_TOOL],
            "tool_choice": {"type": "function", "function": {"name": "verdict"}},
            "temperature": 0.0, "max_tokens": max_tokens}


def parse_verdict(message: dict) -> str:
    """The forced tool call's verdict, else a JSON object in the content (fallback only, for a gateway model
    that ignores tool_choice). Raises on anything else; the caller treats that as no verdict and retries."""
    args = None
    for call in message.get("tool_calls") or []:
        fn = call.get("function") or {}
        if fn.get("name") == "verdict":
            args = json.loads(fn.get("arguments") or "{}")
            break
    if args is None:
        text = str(message.get("content") or "")
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("no verdict in review reply")
        args = json.loads(text[start:end + 1])
    verdict = str(args.get("verdict") or "")
    if verdict not in VERDICTS:
        raise ValueError(f"unknown verdict {verdict!r}")
    return verdict
