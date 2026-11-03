# Real local model, baked into the image at build time (needs internet ONCE, on the connected build machine).
# After that the image is saved into the offline bundle and never downloads anything again.
FROM ollama/ollama:latest
ARG MODEL=qwen2.5:0.5b
# Store models outside any volume path so they stay inside the image layers.
ENV OLLAMA_MODELS=/models
RUN set -e; \
    export OLLAMA_HOST=127.0.0.1:11434; \
    ollama serve & pid=$!; \
    until ollama list >/dev/null 2>&1; do sleep 1; done; \
    ollama pull "$MODEL"; \
    kill $pid; wait $pid || true
ENV OLLAMA_HOST=0.0.0.0:11434
