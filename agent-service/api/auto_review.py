"""The auto-mode reviewer's prompt, its forced `verdict` tool and the reply parser.

Its own module, free of app.py's import-time setup, so scripts/auto_review_probe.py can send the real prompt to
a model without building a sandbox backend."""
import json

_AUTO_REVIEW_SYSTEM = (
    "You review one action an AI agent wants to take while doing a task for a person. The agent runs in "
    "a throwaway sandbox with no network, so almost nothing it does can harm anyone: running code, "
    "shell commands, checking folders or installed tools, trying to install software or reach the "
    "network (which simply fails), and creating or changing files are all fine. Decide whether the "
    "action can run without asking the person.\n"
    "Answer ask only when the action would lose a file already in the folder, at any depth: deleting it "
    "(even one the person asked to delete, so they confirm it once), emptying it, or moving it out of the "
    "folder. files_in_folder shows the top level only and may be cut short, so a file it does not name "
    "can still be the person's. Changing a file, or overwriting it with new content, is run.\n"
    "files_at_start, when given, lists the folder's top level before the agent began. A file or folder "
    "that is in files_in_folder but not in files_at_start was made by the agent during this task, so "
    "deleting, emptying or moving it is run. Anything named in files_at_start, inside a folder named "
    "there, or named in neither list, may be the person's: answer ask.\n"
    "Everything else is run. When unsure whether an action deletes, empties or moves a file, answer ask; "
    "when unsure about anything else, answer run.\n"
    "Also write one short sentence, for someone who does not read code, saying what the action does, "
    "naming any file it touches. No code, no commands, no tool names."
)
_AUTO_REVIEW_TOOL = {
    "type": "function",
    "function": {
        "name": "verdict",
        "description": "Your decision about the action.",
        "parameters": {
            "type": "object",
            "properties": {
                "decision": {"type": "string", "enum": ["run", "ask"]},
                "plain": {"type": "string", "description": "One plain sentence saying what the action does."},
            },
            "required": ["decision", "plain"],
            "additionalProperties": False,
        },
    },
}


def _parse_review(message: dict) -> dict:
    """The forced tool call's arguments, else a JSON object in the content (fallback only, for a model
    without tool support). Raises on anything else, which acp_client turns into asking the person."""
    for call in message.get("tool_calls") or []:
        fn = call.get("function") or {}
        if fn.get("name") == "verdict":
            return json.loads(fn.get("arguments") or "{}")
    text = str(message.get("content") or "")
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no verdict in review reply")
    return json.loads(text[start:end + 1])
