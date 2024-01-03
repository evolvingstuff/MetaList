
# MetaList

<img src="docs/img/MetaList-Logo.png" width="130" />


## What is MetaList?
MetaList is an evolving web application for personal knowledge management, 
integrated with large language models like OpenAI's API. 
Currently in its early stages, it provides fundamental functionalities 
such as hierarchical note-taking, and AI-powered chat interactions and 
data visualizations. 

*This initial version is subject to significant changes.*

## Features

- Chat feature: LLM integration (currently only [OpenAI API](https://openai.com/blog/openai-api))
- [Chart.js](https://www.chartjs.org/) integration for LLM-generated visualizations
- Hierarchical, collapsable note structure
- Reordering notes in one context survives to other search contexts; notes maintain a [total order](https://en.wikipedia.org/wiki/Total_order)
- Quick, responsive searching (tags, full-text, or combo of both)
- Search suggestions
- Tagging
- Tag suggestions (uses a [Jaccard index](https://en.wikipedia.org/wiki/Jaccard_index))
- Tags can imply other tags
- Tag implication rules are also notes; they can themselves be tagged and searched
- Nested subitems in notes inherit tags from their parents
- [Markdown](https://markdown-it.github.io/)/[LaTeX](https://katex.org/) support
- Infinite undo/redo
- Infinite scrolling

## Chat Feature

Search filters down to relevant notes, which has the nice 
effect of acting as a form of human-guided [retrieval augmented generation](https://www.promptingguide.ai/techniques/rag).

Some examples of interactions with the chat feature:

![demo](docs/img/demo-1.gif)

<img src="docs/img/chat-example-2.png"/>
<img src="docs/img/chat-example-3.png"/>

## Roadmap

- Chat integration with other models
- Menus / settings
- Reminders
- Passwords / encryption at rest
- Export notes to JSON, Markdown, HTML, PDF
- File handling
- Access to local file system
- Multi-user
- Mobile friendly

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

