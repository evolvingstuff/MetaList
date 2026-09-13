"""Expected, explicitly validated user-input failures, never internal defects."""


class InputRejected(ValueError):
    pass


class ResourceNotFound(KeyError):
    pass


class NamespaceInputRejected(RuntimeError):
    pass
