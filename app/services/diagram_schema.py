"""Required-field v3 diagram source contract; legacy versions remain supported."""
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Point(StrictModel):
    x: float = Field(ge=-200000, le=200000, allow_inf_nan=False)
    y: float = Field(ge=-200000, le=200000, allow_inf_nan=False)


class FreeEndpoint(Point):
    kind: Literal["free"]


class FloatingEndpoint(StrictModel):
    kind: Literal["floating"]
    shape_id: str = Field(min_length=1, max_length=80)


class AttachedEndpoint(StrictModel):
    kind: Literal["attached"]
    shape_id: str = Field(min_length=1, max_length=80)
    u: float = Field(ge=0, le=1, allow_inf_nan=False)
    v: float = Field(ge=0, le=1, allow_inf_nan=False)


Endpoint = Annotated[FreeEndpoint | AttachedEndpoint | FloatingEndpoint, Field(discriminator="kind")]


class TextRun(StrictModel):
    text: str = Field(max_length=5000)
    bold: bool
    italic: bool
    color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")


class LabeledObject(StrictModel):
    id: str = Field(min_length=1, max_length=80)
    runs: list[TextRun] = Field(max_length=5000)
    font_size: int = Field(ge=12, le=48)
    stroke: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")
    stroke_width: int = Field(ge=1, le=6)

    @model_validator(mode="after")
    def validate_text_size(self):
        if sum(len(run.text) for run in self.runs) > 5000:
            raise ValueError("A diagram label cannot exceed 5000 characters")
        return self


class Shape(LabeledObject):
    type: Literal["rectangle", "rounded", "ellipse", "diamond", "text"]
    x: float = Field(ge=-100000, le=100000, allow_inf_nan=False)
    y: float = Field(ge=-100000, le=100000, allow_inf_nan=False)
    width: float = Field(ge=40, le=4000, allow_inf_nan=False)
    height: float = Field(ge=40, le=400000, allow_inf_nan=False)
    fill: str = Field(pattern=r"^(#[0-9a-fA-F]{6}|none)$")


class Arrow(LabeledObject):
    start: Endpoint
    end: Endpoint
    points: list[Point] = Field(max_length=256)
    routing: Literal["straight", "orthogonal"]
    start_head: bool
    end_head: bool
    label_width: float = Field(ge=40, le=4000, allow_inf_nan=False)


class Group(StrictModel):
    id: str = Field(min_length=1, max_length=80)
    members: list[str] = Field(min_length=2, max_length=600)


class Grid(StrictModel):
    visible: bool
    snap: bool
    size: int = Field(ge=5, le=100)


class DiagramSource(StrictModel):
    shapes: list[Shape] = Field(max_length=200)
    arrows: list[Arrow] = Field(max_length=400)
    groups: list[Group] = Field(max_length=300)
    order: list[str] = Field(max_length=600)
    grid: Grid

    @model_validator(mode="after")
    def validate_graph(self):
        shape_ids = {shape.id for shape in self.shapes}
        object_ids = [shape.id for shape in self.shapes] + [arrow.id for arrow in self.arrows]
        all_ids = object_ids + [group.id for group in self.groups]
        if len(all_ids) != len(set(all_ids)):
            raise ValueError("Diagram IDs must be unique")
        if len(self.order) != len(object_ids) or set(self.order) != set(object_ids):
            raise ValueError("Drawing order must contain every object exactly once")
        grouped = set()
        for group in self.groups:
            for member in group.members:
                if member not in object_ids or member in grouped:
                    raise ValueError("Groups require unique, nonoverlapping object membership")
                grouped.add(member)
        for arrow in self.arrows:
            for endpoint in (arrow.start, arrow.end):
                if endpoint.kind != "free" and endpoint.shape_id not in shape_ids:
                    raise ValueError("Attached endpoints must identify a shape in this diagram")
        return self


class DiagramDocument(StrictModel):
    kind: Literal["diagram"]
    version: Literal[3]
    source: DiagramSource


class ThemedDiagramSource(DiagramSource):
    theme: Literal["clean", "hand-drawn"]


class ThemedDiagramDocument(StrictModel):
    kind: Literal["diagram"]
    version: Literal[4]
    source: ThemedDiagramSource
