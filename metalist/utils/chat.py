from typing import List


ROLE_USER = 'user'
ROLE_SYSTEM = 'system'
ROLE_ASSISTANT = 'assistant'


class ChatHistory:
    def __init__(self, search_filter):
        self.search_filter = search_filter
        self.chat_history: List[ChatMessage] = list()
        # search context?
        # TODO: initialize prompt/s


class ChatMessage:
    def __init__(self, role, content):
        self.role: str = role
        self.content: str = content
