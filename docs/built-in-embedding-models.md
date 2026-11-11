# Built-in embedding models

语义搜索 (search by meaning) needs a model that turns text into vectors. A
person can connect their own model service, or pick a small model that FULI
downloads and runs on this computer: no endpoint, no key, and no knowledge
leaves the computer.

## What a person does

模型 › 语义搜索 › 「内置模型」 lists the catalog. 「下载并使用」 downloads a model
and switches search to it when the download is whole; the meaning index then
fills in the background. An installed model that search does not use can be
removed. An Agent can do the same for the person while 模型设置 is on in AI
permissions (`skills/operating-fuli`).

## The catalog

`registry/embedding-models.json` lists the models. FULI ships a copy and
updates it once a day from the public copy on `main`, so a new model reaches
people without a FULI release:

`https://raw.githubusercontent.com/JevonsCode/fuli/main/registry/embedding-models.json`

Each model names its three data files with their size, SHA-256 and download
addresses:

```json
{
  "id": "bge-small-zh-v1.5",
  "name": "BGE Small 中文 v1.5",
  "license": "MIT",
  "languages": ["zh"],
  "dimensions": 512,
  "maxTokens": 512,
  "pooling": "cls",
  "lowercase": true,
  "stripAccents": false,
  "recommended": true,
  "memoryMb": 200,
  "summary": { "zh": "…", "en": "…" },
  "source": "https://huggingface.co/BAAI/bge-small-zh-v1.5",
  "revision": "<full commit id>",
  "files": [
    { "path": "config.json", "bytes": 776, "sha256": "…", "urls": ["https://huggingface.co/…/resolve/<revision>/config.json", "https://hf-mirror.com/…"] }
  ]
}
```

A copy is accepted only whole, and only when:

- every file is one of `config.json`, `vocab.txt`, `model.safetensors`: data
  the graph service reads, never a program;
- every address is https on `huggingface.co` or `hf-mirror.com` and names the
  model's commit, so the file behind it cannot change;
- the licence is MIT or Apache-2.0;
- exactly one model is recommended.

## Adding a model

A model fits when it is a BERT encoder with a WordPiece vocabulary
(`vocab.txt`), absolute positions and GELU, published as `model.safetensors`.
Take `pooling` from its `1_Pooling/config.json`. `lowercase` and
`stripAccents` follow how the model was trained: compare FULI's vectors with
the reference implementation on mixed text (accents, upper case, Chinese)
before listing it, and raise `manifestVersion`.

## How it runs

- Node downloads each file to a partial folder and keeps it only when its size
  and SHA-256 are the catalog's; the mirror is tried when the first address
  fails or answers other bytes. A model's folder under
  `<data>/models/embedding/<id>/` gets `fuli-model.json` last; a folder
  without it is not a model.
- The graph service runs the model with numpy alone
  (`graph-provider/fuli_graph/builtin_embedding.py`): it reads the safetensors
  file through a memory map, tokenizes with WordPiece and runs the encoder.
  Nothing is loaded until the first text arrives, and one model is kept
  loaded.
- Search uses it through the `builtin_embeddings` connection of the semantic
  role. It sends nothing out, so no project needs approving for it.

Built-in models need FULI's own graph service on this computer; an older
Docker-based graph cannot read the downloaded files.
