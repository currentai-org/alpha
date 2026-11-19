"""The files a person attached in chat reach the agent.

/run used to carry text only, so a photo attached with Agent set to On never reached the agent, which
answered a question about a picture it had not seen. These drive `_run` with the ACP transport stubbed
and read what the stub was handed: the workdir at the moment the agent starts, and the prompt blocks.
"""
import base64
import os
import tempfile

import acp_client
import app
import pytest
from acp.schema import ImageContentBlock, TextContentBlock
from fastapi import HTTPException

# Eight bytes of PNG signature and a little body: the service copies bytes, it never decodes an image.
PHOTO = b"\x89PNG\r\n\x1a\n" + b"blue circle on yellow" * 4
PHOTO_B64 = base64.b64encode(PHOTO).decode()


def _photo_file(name: str = "shapes.png", **kw) -> app.RunFile:
    return app.RunFile(name=name, mime="image/png", data=PHOTO_B64, **kw)


def _run_capturing(task: app.Task) -> dict:
    """Run `task` on the ACP path with the agent stubbed out; returns what the stub saw."""
    seen: dict = {}

    def observe(work: str, prompt: str, images: list) -> None:
        path = os.path.join(work, "attachments", "shapes.png")
        seen["workdir_photo"] = open(path, "rb").read() if os.path.isfile(path) else None
        seen["prompt"] = prompt
        seen["blocks"] = acp_client.prompt_blocks(prompt, images)
        with open(os.path.join(work, "answer.txt"), "w") as f:     # something the agent "made"
            f.write("the circle is blue")

    async def fake_acp_run(*a, **kw):
        observe(a[0], a[2], kw.get("images") or [])
        return "The circle is blue.", None, 0

    saved = (app.HERMES_BIN, app.AGENT_ACP, app.MODEL_PROXY_URL, app.SANDBOX_REQUIRED, app.MODERATION_DISABLED,
             app.KEEP_WORKDIR, acp_client._acp_run)
    app.HERMES_BIN, app.AGENT_ACP, app.MODEL_PROXY_URL, app.SANDBOX_REQUIRED, app.MODERATION_DISABLED = (
        "/bin/true", True, "", False, True)
    app.KEEP_WORKDIR = False
    acp_client._acp_run = fake_acp_run
    try:
        app._run(task)
    finally:
        (app.HERMES_BIN, app.AGENT_ACP, app.MODEL_PROXY_URL, app.SANDBOX_REQUIRED, app.MODERATION_DISABLED,
         app.KEEP_WORKDIR, acp_client._acp_run) = saved
    return seen


def test_an_attached_photo_is_in_the_workdir_and_in_the_model_request_as_an_image():
    task = app.Task(id="att-photo-1", prompt="What colour is the circle in my photo?", user="dev-bypass-user")
    task._attachments = app._decode_attachments([_photo_file()])

    seen = _run_capturing(task)

    assert seen["workdir_photo"] == PHOTO, "the photo was not copied into the workdir before the agent started"
    images = [b for b in seen["blocks"] if isinstance(b, ImageContentBlock)]
    assert [(b.mime_type, b.data) for b in images] == [("image/png", PHOTO_B64)], \
        "the photo is not in the model request as an image block"
    assert isinstance(seen["blocks"][0], TextContentBlock)
    assert "attachments/shapes.png (image/png)" in seen["prompt"], "the agent is not told where the photo is"


def test_the_attached_photo_is_not_listed_as_a_file_the_turn_produced():
    task = app.Task(id="att-photo-2", prompt="What colour is the circle?", user="dev-bypass-user")
    task._attachments = app._decode_attachments([_photo_file()])

    _run_capturing(task)

    names = [a["name"] for a in task.artifacts]
    assert "answer.txt" in names
    assert "attachments/shapes.png" not in names, "the person's own photo came back as the agent's output"
    assert task._attachments == [], "the photo's bytes are kept on the task after the run"


def test_a_turn_with_no_attachments_sends_text_only():
    task = app.Task(id="att-none-1", prompt="hi", user="dev-bypass-user")
    seen = _run_capturing(task)
    assert all(isinstance(b, TextContentBlock) for b in seen["blocks"])
    assert "attached these files" not in seen["prompt"]


def test_the_models_rendition_is_sent_in_place_of_the_full_photo():
    small = base64.b64encode(b"\xff\xd8\xff small jpeg").decode()
    [a] = app._decode_attachments([_photo_file(image=app.RunImage(mime="image/jpeg", data=small))])
    assert a.data == PHOTO, "the workdir copy is the full file"
    assert a.model_image == ("image/jpeg", small)


def test_a_file_that_is_not_an_image_is_copied_but_not_shown():
    [a] = app._decode_attachments([app.RunFile(name="notes.csv", mime="text/csv", data=PHOTO_B64)])
    assert a.rel == "attachments/notes.csv" and a.model_image is None


def test_names_are_one_safe_segment_and_never_collide():
    got = app._decode_attachments([
        _photo_file("../../etc/passwd"), _photo_file("C:\\Users\\me\\shapes.png"), _photo_file("shapes.png"),
        _photo_file(".."), _photo_file("bad\x00name.png"),
    ])
    assert [a.rel for a in got] == ["attachments/passwd", "attachments/shapes.png", "attachments/shapes-2.png",
                                    "attachments/attachment", "attachments/badname.png"]


def test_a_file_that_is_not_base64_refuses_the_run():
    with pytest.raises(HTTPException) as e:
        app._decode_attachments([app.RunFile(name="x.png", mime="image/png", data="not base64!")])
    assert e.value.status_code == 400


def test_files_over_the_total_cap_refuse_the_run(monkeypatch):
    monkeypatch.setattr(app, "ATTACHMENT_TOTAL_MAX_BYTES", len(PHOTO) * 2 - 1)
    with pytest.raises(HTTPException) as e:
        app._decode_attachments([_photo_file("a.png"), _photo_file("b.png")])
    assert e.value.status_code == 413


def test_seeding_never_follows_a_link_an_earlier_turn_planted():
    """A continued session's workdir is the agent's: a link named `attachments` pointing outside it must not
    turn this process's write into a write elsewhere on the host."""
    with tempfile.TemporaryDirectory() as work, tempfile.TemporaryDirectory() as outside:
        os.symlink(outside, os.path.join(work, "attachments"))
        [a] = app._decode_attachments([_photo_file()])
        assert app._seed_attachments(work, [a], "att-link-1") == []
        assert os.listdir(outside) == []
