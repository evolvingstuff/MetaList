"use strict";

const META_PREFIX = '@';

const META_IMPLIES = '@implies';
const META_TODO = '@todo';
const META_DONE = '@done';
const META_LIST_NUMBERED = '@list-numbered';
const META_LIST_BULLETED = '@list-bulleted';
const META_DATE_HEADLINE = '@date-headline';
const META_FILE = '@file';
const META_GOTO = '@goto';
const META_EMBED = '@embed';
const META_USERNAME = '@username';
const META_PASSWORD = '@password';
const META_EMAIL = '@email';
const META_PRIVATE = '@private';
const META_HIDE = '@hide';  //TODO dup with META_HIDDEN?
const META_COPYABLE = '@copyable';
const META_MARKDOWN = '@markdown';
const META_CSV = '@csv';
const META_JSON = '@json';
const META_MONOSPACE = '@monospace';
const META_MONOSPACE_DARK = '@monospace-dark';
const META_SHELL = '@shell';
const META_LATEX = '@LaTeX';
//const META_UML = '@uml';
const META_MATRIX = '@matrix';
//const META_QR = '@qr';
const META_HTML = '@html';
const META_TEXT_ONLY ='@text-only';
const META_BOLD = '@bold';
const META_ITALIC = '@italic';
const META_STRIKETHROUGH = '@strikethrough';
const META_HEADING = '@heading';
const META_RED = '@red';
const META_GREEN = '@green';
const META_BLUE = '@blue';
const META_GREY = '@grey';
const META_HIDDEN = '@hidden';
const META_BROKEN_SEARCH = '@broken-search';
const META_H1 = '@h1';
const META_H2 = '@h2';
const META_H3 = '@h3';
const META_H4 = '@h4';
const META_ID = '@id';
const META_SUBITEM_INDEX = '@subitem-index';
const META_DATE = '@date';
const META_CODE = '@code';
const META_COLOR = '@color';
const META_BACKGROUND_COLOR = '@background-color';
const META_FONT = '@font';
//const META_DEFINITION = '@definition';
//const META_PROGRESS = '@progress';
const META_PROGRESS_ACTIVE = '@progress-active';
const META_THUMBS_UP = '@thumbs-up';
const META_THUMBS_DOWN = '@thumbs-down';

//TODO: add in an ordering to all tags?

const PROTECTED_TAGS = [
       META_ID,
       META_SUBITEM_INDEX,
       META_DATE
];
const UNCACHEABLE_TAGS = [
       META_EMBED, 
       //META_UML, 
       META_HIDDEN
       //META_QR
];
const CASCADING_META_TAGS = [META_HIDDEN];
const DEFAULT_HIDDEN_TAGS = [META_HIDDEN];
const DOWNPROPAGATE_NUMERIC_TAGS = false;
const SUGGESTED_META = [
       META_IMPLIES, 
       META_TODO, 
       META_DONE,
       META_LIST_BULLETED, 
       META_LIST_NUMBERED,
       META_FILE,
       //META_DEFINITION,
       //META_PROGRESS,
       META_PROGRESS_ACTIVE,
       META_DATE_HEADLINE,
       META_GOTO, 
       META_EMBED,
       META_USERNAME, 
       META_PASSWORD, 
       META_EMAIL,
       META_PRIVATE, 
       META_HIDE, 
       META_COPYABLE,
       META_CODE,
       META_MARKDOWN, 
       META_CSV, 
       META_JSON,
       META_MONOSPACE, 
       META_MONOSPACE_DARK, 
       META_SHELL,
       META_LATEX, 
       //META_UML,
       META_MATRIX,
       //META_QR,
       META_HTML,
       META_TEXT_ONLY,
       META_BOLD, 
       META_ITALIC, 
       META_STRIKETHROUGH,
       META_HEADING,
       META_RED, 
       META_GREEN, 
       META_BLUE, 
       META_GREY,
       META_HIDDEN,
       META_COLOR,
       META_BACKGROUND_COLOR,
       META_FONT,
       META_THUMBS_UP,
       META_THUMBS_DOWN
];