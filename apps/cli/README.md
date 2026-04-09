# UMR

> The Unified Model Registry for your local AI apps.

[Get Started](#getting-started) ⋅ [Docs](https://github.com/EvanZhouDev/umr?tab=readme-ov-file) ⋅ [GitHub](https://github.com/EvanZhouDev/umr)

UMR allows you to maintain a single, centralized copy of a model to use across your favorite local AI apps, instead of having each one manage a separate copy.

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
umr show gemma-4-e2b-it-q8-0 --path

# Run it with llama.cpp, for example
llama-cli -m "$(umr show gemma-4-e2b-it-q8-0 --path)"
```

See [GitHub](https://github.com/EvanZhouDev/umr?tab=readme-ov-file) for full documentation.