//https://stackoverflow.com/questions/4233265/contenteditable-set-caret-at-the-end-of-the-text-cross-browser/4238971

function placeCaretAtEndContentEditable(el) {
    el.focus();
    if (typeof window.getSelection != "undefined"
            && typeof document.createRange != "undefined") {
        var range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    } else if (typeof document.body.createTextRange != "undefined") {
        var textRange = document.body.createTextRange();
        textRange.moveToElementText(el);
        textRange.collapse(false);
        textRange.select();
    }
}

function placeCaretAtEndInput(el) {
    if (typeof el.selectionStart == "number") {
        el.selectionStart = el.selectionEnd = el.value.length;
    } else if (typeof el.createTextRange != "undefined") {
        el.focus();
        var range = el.createTextRange();
        range.collapse(false);
        range.select();
    }
}

///////////////////////////////////////////////////////////////////////

function getCaretPosition(el) {
    var selection = window.getSelection();
    var range = selection.getRangeAt(0);
    range.setStart(el, 0);
    console.log('innerText = ' + el.innerText);
    return {
        location: range.toString().length,
        textLength: el.innerText.length
    }
}