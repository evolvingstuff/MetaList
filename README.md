# MetaList

MetaList is a personal knowledge management web app that is tightly integrated with an LLM chat interface with RAG.

## Features

- LLM integration (currently only [OpenAI API](https://openai.com/blog/openai-api))
- [Chart.js](https://www.chartjs.org/) integration for LLM-generated visualizations
- Hierarchical, collapsable note structure
- Reordering notes in one context survives to other search contexts; notes maintain a [total order](https://en.wikipedia.org/wiki/Total_order)
- Quick, responsive searching (tags, full-text, or combo of both)
- Search suggestions
- Tagging
- Tag suggestions (uses a [Jaccard index](https://en.wikipedia.org/wiki/Jaccard_index))
- Tags can imply other tags
- Tag implication rules are also items; they can themselves be tagged and searched
- Nested subitems in notes inherit tags from their parents
- [Markdown](https://markdown-it.github.io/)/[LaTeX](https://katex.org/) support
- Infinite undo/redo
- Infinite scrolling

## Chat

Search filters down to relevant notes, which has the nice 
effect of acting as a form of human-guided [retrieval augmented generation](https://www.promptingguide.ai/techniques/rag).

Some examples of interactions with the chat feature:

<img src="docs/chat-example-1.png" width="600" />
<img src="docs/chat-example-2.png" width="600" />
<img src="docs/chat-example-3.png" width="600" />

## Future features

- Chat integration with other models
- Passwords / encryption at rest
- Export notes to HTML
- Export notes to PDF
- Export notes to Markdown
- Export notes to JSON
- File handling
- Access to local file system

## Installation

It is recommended that you create a Python virtual environment before installing MetaList.

```bash
python3 -m venv venv
source venv/bin/activate
```

Then, install MetaList using pip:

```bash
pip install metalist
```

## Usage

Navigate to `http://127.0.0.0:8080/`

## License

MetaList is licensed under the MIT license. See [LICENSE](LICENSE) for more information.

