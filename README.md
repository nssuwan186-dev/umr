<p align="center">
  <picture>
    <source
      media="(prefers-color-scheme: dark)"
      srcset="./assets/umr-banner@dark.png"
    />
    <source
      media="(prefers-color-scheme: light)"
      srcset="./assets/umr-banner@light.png"
    />
    <img
      alt="UMR banner"
      src="./assets/umr-banner@light.png"
    />
  </picture>
</p>

<p align="center">
  <a href="#getting-started">Get Started</a>
  &nbsp;·&nbsp;
  <a href="#what-is-umr">Docs</a>
  &nbsp;·&nbsp;
  <a href="https://www.npmjs.com/package/umr-ai">NPM</a>
</p>

```
npm i -g umr-ai
```

# What is UMR?

![](./assets/no-umr.png)

UMR is the Unified Model Registry for your local AI apps. It allows you to maintain a single, centralized copy of a model to use across your favorite local AI apps, instead of having each one manage a separate copy.

![](./assets/with-umr.png)

That means you can:
- Save disk space
- Use the same model across all of your apps instantly
- Manage all your local models in one place

# Install

Install UMR via NPM or your JS package manager of choice.

```
npm i -g umr-ai
```

The `umr` CLI will be available after installation.

# Getting Started

Get started by adding a model to the UMR-maintained registry.

```bash
# Add a model from Hugging Face
# You will be prompted to choose a quant version
# This will use HF Cache, but UMR will now know about it
umr add hf ggml-org/gemma-4-E2B-it-GGUF

# Add a GGUF file manually
# This will make a copy of the GGUF to UMR's own store
umr add ./gemma-4-E2B-it-q8-0.gguf
```

After adding, check your available models

```bash 
# Output depends on which quant you chose
umr list


# NAME                 SOURCE  FORMAT  SIZE     CLIENTS    STATUS
# gemma-4-e2b-it-q8-0  hf      gguf    4.63 GB  -          ok
```

Now you can use the model in all your favorite apps right away. `umr link` is lightning fast, and the model should appear immediately in the linked app.

```bash
# Link the model to LM Studio
umr link lmstudio gemma-4-e2b-it-q8-0

# Link the model to Ollama
umr link ollama gemma-4-e2b-it-q8-0

# Link the model to Jan
umr link jan gemma-4-e2b-it-q8-0
```

Alternatively, you can also get the raw GGUF path to use with other AI runtimes

```bash
# Get the path to the GGUF
umr show gemma-4-e2b-it --path

# Run it with llama.cpp, for example
llama-cli -m "$(umr show gemma-4-e2b-it --path)"
```

# Docs

UMR manages models in three layers:

- **Source**: where a model comes from, like Hugging Face or a local file
- **Model**: the canonical copy UMR tracks and stores
- **Client**: an app that uses that model, like LM Studio, Ollama, or Jan

Add a model once, then link it anywhere you want to use it.

## Commands

### `umr add`

Add a model to UMR from Hugging Face or a local GGUF file.

```bash
umr add hf <repo>
umr add ./model.gguf
```

### `umr list`

List the models UMR is tracking, including source, format, linked clients, and status.

```bash
umr list
```

### `umr show`

Show details for a tracked model, or print only the managed file path with `--path`.

```bash
umr show <model>
umr show <model> --path
```

### `umr link`

Link a tracked model to a client app.

```bash
umr link lmstudio <model>
umr link ollama <model>
umr link jan <model>
```

### `umr unlink`

Remove a client link from a tracked model.

```bash
umr unlink lmstudio <model>
umr unlink ollama <model>
umr unlink jan <model>
```

### `umr remove`

Remove a model from UMR. A model must be unlinked from all clients before it can be removed.

```bash
umr remove <model>
```

### `umr check`

Check UMR for missing files or stale client links. Use `--fix` to remove stale UMR-side links automatically when it is safe to do so.

```bash
umr check
umr check --fix
```
