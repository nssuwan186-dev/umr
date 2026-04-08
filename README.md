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

The Unified Model Registry (UMR) allows you to maintain a single, centralized copy of a model's weights for every local AI app across your system.

![](./assets/with-umr.png)

By either linking model files or pointing the AI app to the UMR-maintained copy of the model weights, UMR helps you save storage space and unify management of your local AI models.

# Install

Install UMR via NPM or your JS package manager of choice.

```
npm i -g umr-ai
```

# Getting Started

Get started by adding a model to the UMR-maintained registry.

```bash
# Add a model from Hugging Face
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

# NAME                 SIZE      TARGETS       STATUS
# gemma-4-e2b-it-q8-0  4.63 GB   -             ok
```

Now, you can use your available model with your favorite apps!

```bash
# Link the model to LM Studio
umr link lmstudio gemma-4-e2b-it-q8-0

# Link the model to Ollama
umr link ollama gemma-4-e2b-it-q8-0

# Link the model to Jan
umr link jan gemma-4-e2b-it-q8-0
```

Or, get the GGUF path to use with other AI runtimes

```bash
# Get the path to the GGUF
umr show gemma-4-e2b-it --path

# Run it with llama.cpp, for example
llama-cli -m "$(umr show gemma-4-e2b-it --path)"
```
