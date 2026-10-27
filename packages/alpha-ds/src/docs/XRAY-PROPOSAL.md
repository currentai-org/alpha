# X-ray panel

The X-ray panel shows what happened behind an answer: whether the message was checked, what was
looked up, who made the model, where it ran and where the data goes. It is written for a
non-technical reader, so it avoids infrastructure terms such as "RAG", "inference" or project names.

## Entry points

- The **X-ray pill** under the message box, beside the **Private** pill. It uses the `xray` tone of
  `ComposerAccessory` and opens a panel at the composer's width.
- The footer line under every answer: the maker's logo, then "Swiss AI Initiative · Apertus · How
  this was made". It opens X-ray on that answer (`xrayMessageId`).
- The welcome dialog's call to action.

The system prompt in `persona.ts` refers to the panel as "XRAY VIEW". Renaming the panel means
changing the prompt, which needs a live probe to confirm the model still describes it correctly.

## Tabs

1. **This answer** (default) is a receipt for the selected answer, in the order things happened:
   - **Safety**: checked and clear, declined, or the check couldn't run. The panel never says
     "passed" for a check that didn't run.
   - **Looked up**: web results and knowledge-base passages with counts, or "answered from what the
     model already knows".
   - **The model / Where it ran / Your data**: the same provenance breakdown the composer's
     **Private** pill opens. It credits the model maker, the host (as reported by the gateway for
     this request, when it reports one) and Hugging Face's private storage.
   - **Second opinion**, when one was requested.

   A **Step by step** disclosure holds the full provenance trace and its second-opinion action.
   Every line reads from `provenanceFacts`, so the receipt and the trace always agree.

2. **The stack** shows a card for each layer of Alpha's open stack (model, compute, safety,
   retrieval, voice and so on), one per roadmap product. The layers the current turn used expand and
   animate while an answer streams.

Answers carry no inline trace or badge. A safety decline still shows inline.

## Visual style

The panel uses the normal surface and text tokens so it stays readable. Its identity is limited to:

- a cool hue (`--ds-xray-glow`, adjusted for light and dark mode, AA contrast as small text) on the
  entry mark and a hairline
- a faint scan grid that fades out across the panel's header band (`xray-band`)
- on the pill, the standard pill shape with a cool icon, a slow, faint sweep and the label "X-ray"

## Implementation

All paths are under `web/src/lib/chat/components/`.

- `stack/XRayComposerPanel.svelte`
- `stack/AnswerReceipt.svelte`
- `provenance/AnswerFooter.svelte`
- `provenance/ProvenanceBreakdown.svelte`, shared with the Private panel

## Open work

- Show energy and time, which are in the header footprint, in the receipt as the cost of the answer.
- Rename the panel to something self-explanatory, such as "Behind the answer", together with the
  `persona.ts` prompt change and a live probe.
