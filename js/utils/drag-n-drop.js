"use strict";

//https://gist.github.com/andjosh/7867934
if (window.File && window.FileReader && window.FileList && window.Blob) {
    function handleJSONDrop(evt) {

        //TODO: factor this out
        if ($todo.itemIsSelected()) {
            console.log('Nothing selected, leaving...');
            //Allow dragging into editable items
            return;
        }

        evt.stopPropagation();
        evt.preventDefault();
        let files = evt.dataTransfer.files;
        // Loop through the FileList and read
        for (let i = 0; i < files.length; i++) {
            let f = files[i];
            // Only process json files.
            //check for name ending with .json
            let reader = new FileReader();
            // Closure to capture the file information.
            reader.onload = (function (theFile) {
                return function (e) {
                    let data = JSON.parse(e.target.result);
                    $todo.restoreFromFile(data);
                };
            })(f);
            reader.readAsText(f);
        }
    }
    function handleDragOver(evt) {

        //TODO factor this out
        if ($todo.itemIsSelected()) {
            //Allow dragging into editable items
            return;
        }

        //console.log('handleDragOver()');
        evt.stopPropagation();
        evt.preventDefault();
        evt.dataTransfer.dropEffect = 'copy'; // Explicitly show this is a copy.
    }
    // Setup the dnd listeners.
    let dropZone = document.getElementsByTagName('body')[0];
    dropZone.addEventListener('dragover', handleDragOver, false);
    dropZone.addEventListener('drop', handleJSONDrop, false);
}
else {
    alert('The File APIs are not fully supported in this browser.');
}
