"""nli_worker — a resident zero-shot entailment scorer, spoken to over stdio.

WHAT THIS IS. One long-lived Python process holding one NLI model in memory,
answering scoring requests until its stdin closes. It is the first RESIDENT
subprocess in foundry: `vlm_page.py` is a batch worker (config in, pages out,
stdin closed at the start), and this one keeps stdin open because the model
costs ten to ninety seconds to load and a book is scored in several passes.

THE WIRE, and it is briefcase's verbatim so its measurements transfer:

    worker -> {"ready": true, "device": "cuda|mps|cpu", "model": "..."}
    host   -> {"id": 1, "texts": ["..."], "hypotheses": ["..."]}
    worker -> {"id": 1, "scores": [[0.91, 0.02], ...]}
    worker -> {"id": 1, "error": "..."}          (this request only; still alive)

`scores` is ROW-MAJOR texts x hypotheses, raw per-hypothesis probabilities.
`multi_label=True`, so a row does NOT sum to 1 — each hypothesis is scored
against the text on its own, which is the whole point: a sentence may entail
three categories at once and an argmax over a softmax would make them compete.

THE ONE PLACE A REIMPLEMENTATION SILENTLY BREAKS, said here and in
docs/ANALYSIS.md §4: the transformers zero-shot pipeline returns `labels` and
`scores` SORTED BY SCORE, DESCENDING. It does not return them in the order the
candidate labels were passed. A worker that zips `result['scores']` straight
into the response hands every text's highest score to whichever category
happened to be first in the list, and the output still looks exactly like
plausible scores. So every row is re-mapped back to the INPUT hypothesis order
by label text before it is emitted, and duplicate hypotheses are refused rather
than collapsed (two identical labels are one entry in that map, and the second
category would silently inherit the first's score).

THE HYPOTHESIS TEMPLATE IS "{}" AND THAT IS LOAD-BEARING. The pipeline's
default is "This example is {}." — written for one-word labels. Every
hypothesis here is a complete sentence ("The author asserts that ..."), and
wrapping one in that template produces "This example is The author asserts
that ...", which is not a proposition and scores like noise. The measured
numbers quoted in plan.ts were taken against the bare hypothesis.

STDOUT IS THE PROTOCOL AND NOTHING ELSE MAY REACH IT. File descriptor 1 is
duplicated into a private handle and then pointed at stderr, exactly as
`vlm_page.py` does and for the reason it learned: a native library below Python
(here: tokenizers, torch, and every progress bar transformers draws) can write
to fd 1 directly, and one such line in the middle of the stream fails the whole
run at the host's JSON parser.

NOTHING HERE EVER RETRIES OR SUBSTITUTES. A request that fails is answered with
an error line naming the failure and the process stays alive for the next one;
a MODEL that will not load is fatal and says so in one sentence naming the
model, the cache it looked in, and the flag that fetches it.
"""
import json
import os
import sys

# The protocol channel is the REAL stdout, held privately, and fd 1 is then
# pointed at stderr. See the module docstring: after this swap nothing in this
# process can reach the host's parser except emit().
_protocol = os.fdopen(os.dup(sys.stdout.fileno()), 'w', encoding='utf-8')
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())

# STDIN IS UTF-8 BY DECLARATION, NOT BY LUCK. The host writes UTF-8; on Windows
# a piped stdin defaults to the ANSI code page with surrogateescape, and under
# cp1252 that read every curly quote in the book as mojibake ('â€™' scored in
# place of an apostrophe) and turned the close-quote's final byte — 0x9d,
# undefined in cp1252 — into the lone surrogate \udc9d, which the Rust
# tokenizer under transformers refuses as "TextInputSequence must be str"
# (Flashpoint of Revival, 2026-08-25: one evening of bisecting, because every
# probe that read the FILES saw clean text and only the PIPE was lying).
# `strict`, not surrogateescape: a byte that is not UTF-8 is a protocol
# violation to be named at the line it arrived on, never smuggled into a score.
sys.stdin.reconfigure(encoding='utf-8', errors='strict')

# The model this worker is. It is a CONSTANT rather than a request field
# because the host writes it into the report header as provenance, and a header
# that named one model while another had been loaded would be a false claim
# about how every score in the file was produced. The host checks the ready
# line's `model` against its own copy of this string.
MODEL_ID = 'MoritzLaurer/deberta-v3-base-zeroshot-v2.0'

# How many texts go to the model at once.
#
# The pipeline is happy to take the whole book in one call and would allocate
# one padded batch for it; a three-hundred-page book is tens of thousands of
# sentences and that allocation is measured in gigabytes on a card that is also
# holding the weights. Thirty-two is small enough that the peak is a function of
# the LONGEST SENTENCE rather than of the book's length, and large enough that
# the per-call overhead is not the cost. Nothing is streamed back per chunk: one
# request is one response, so the chunking is invisible on the wire.
CHUNK = 32


def fail(message):
    """Die the way foundry dies: one line naming the thing, nonzero exit."""
    sys.stderr.write('nli_worker: %s\n' % message)
    sys.exit(1)


def emit(obj):
    _protocol.write(json.dumps(obj, ensure_ascii=False) + '\n')
    _protocol.flush()


def pick_device():
    """cuda, then mps, then cpu — the first one this machine actually has.

    Reported on the ready line so a run that is unexpectedly slow can be
    explained by one word rather than by guesswork. CPU is a legal answer and
    not a failure: it is correct and it is roughly an order of magnitude slower,
    which the host says out loud when it sees it.
    """
    import torch
    if torch.cuda.is_available():
        return 'cuda'
    mps = getattr(torch.backends, 'mps', None)
    if mps is not None and mps.is_available():
        return 'mps'
    return 'cpu'


def load(device):
    """The pipeline, or a refusal naming the model and where it was looked for.

    OFFLINE IS THE NORMAL STATE. The host sets HF_HUB_OFFLINE and
    TRANSFORMERS_OFFLINE, so a missing model fails HERE, in a second, instead of
    the run blocking on a network fetch somewhere inside an analysis that has
    already been going for an hour. The sentence names the flag that lifts the
    offline vars for one run so the weights can be pulled once.
    """
    try:
        from transformers import pipeline
    except Exception as error:  # noqa: BLE001 - the message is the product
        fail(
            'this interpreter (%s) cannot import transformers: %s. The analysis worker needs '
            'torch and transformers; name an interpreter that has them with --nli-python or '
            'FOUNDRY_NLI_PYTHON.' % (sys.executable, error)
        )
    try:
        return pipeline(
            'zero-shot-classification',
            model=MODEL_ID,
            device=device,
        )
    except Exception as error:  # noqa: BLE001 - the message is the product
        fail(
            'could not load %s from %s: %s. Nothing here downloads a model during an analysis. '
            'Pass --fetch-nli-model (or set FOUNDRY_NLI_FETCH=1) once to let this worker pull the '
            'weights, and every run after that is offline.'
            % (MODEL_ID, os.environ.get('HF_HOME', '(the default Hugging Face cache)'), error)
        )


def score(classifier, texts, hypotheses):
    """One request's matrix: len(texts) rows, len(hypotheses) columns.

    The re-map is the whole of this function's risk — see the module docstring.
    Duplicates are refused here rather than deduplicated, because a caller that
    sent the same hypothesis twice believes it is asking two questions and would
    be handed one answer twice with nothing saying so.
    """
    if len(set(hypotheses)) != len(hypotheses):
        raise ValueError('two hypotheses in this request are the same string, so their scores '
                         'could not be told apart')

    rows = []
    for start in range(0, len(texts), CHUNK):
        chunk = texts[start:start + CHUNK]
        # `multi_label=True`: each hypothesis is scored on its own against the
        # text, so the row does not sum to 1. `hypothesis_template='{}'`: the
        # hypothesis IS the sentence and must not be wrapped.
        results = classifier(
            chunk,
            candidate_labels=hypotheses,
            multi_label=True,
            hypothesis_template='{}',
        )
        # A one-element list still comes back as a list from this pipeline, but
        # a bare dict is what it returns for a bare string — handled so a future
        # transformers that normalises differently cannot corrupt a row.
        if isinstance(results, dict):
            results = [results]
        for result in results:
            by_label = dict(zip(result['labels'], result['scores']))
            rows.append([float(by_label[hypothesis]) for hypothesis in hypotheses])
    return rows


def main():
    device = pick_device()
    classifier = load(device)
    emit({'ready': True, 'device': device, 'model': MODEL_ID})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        # A request that cannot even be parsed has no id to answer under, so it
        # is reported on stderr and skipped. The host's per-request timeout is
        # what turns that into a named failure on its side; inventing an id here
        # would answer somebody else's question.
        try:
            request = json.loads(line)
        except Exception as error:  # noqa: BLE001
            sys.stderr.write('nli_worker: ignoring a line that is not JSON: %s\n' % error)
            continue
        request_id = request.get('id')
        try:
            texts = request['texts']
            hypotheses = request['hypotheses']
            if not isinstance(texts, list) or not isinstance(hypotheses, list):
                raise ValueError('a request carries texts and hypotheses, both lists')
            if len(texts) == 0 or len(hypotheses) == 0:
                emit({'id': request_id, 'scores': []})
                continue
            emit({'id': request_id, 'scores': score(classifier, texts, hypotheses)})
        except Exception as error:  # noqa: BLE001 - one bad request must not end the worker
            # The traceback rides IN the response rather than on stderr, because
            # the host echoes stderr only while the model is loading; an error
            # whose only explanation went to a swallowed channel cost an evening
            # of bisecting (2026-08-25, the lone-surrogate hunt) before anyone
            # could see which line of library code had refused. The tail is
            # enough: the deepest frames are where the refusal is named.
            import traceback
            trace = traceback.format_exc()
            emit({
                'id': request_id,
                'error': '%s: %s' % (type(error).__name__, error),
                'trace': trace[-1200:],
            })

    # EOF on stdin is the documented shutdown. Returning normally is the whole
    # of it; the host's SIGKILL exists only for an interpreter that has wedged.
    return 0


if __name__ == '__main__':
    sys.exit(main())
