"use strict";

//https://gist.github.com/andjosh/7867934
if (window.File && window.FileReader && window.FileList && window.Blob) {

    function handleDrop(evt) {

        if ($todo.itemIsSelected()) {
            return;
        }

        evt.stopPropagation();
        evt.preventDefault();

        let url = evt.dataTransfer.getData("URL");
        if (url != '') {
            $todo.actionAddLink(evt, url);
            return;
        }

        //evt.dataTransfer.getData("URL")
        //TODO: only if in correct mode
        

        let files = evt.dataTransfer.files;
        for (let i = 0; i < files.length; i++) {
            let f = files[i];
            console.log('f = ' + f);
            //TODO: Only process json files.
            let reader = new FileReader();
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

        if ($todo.itemIsSelected()) {
            return;
        }

        evt.stopPropagation();
        evt.preventDefault();
        evt.dataTransfer.dropEffect = 'copy'; // Explicitly show this is a copy.
    }

    // Setup the dnd listeners.
    let dropZone = document.getElementsByTagName('body')[0];
    dropZone.addEventListener('dragover', handleDragOver, false);
    dropZone.addEventListener('drop', handleDrop, false);
}
else {
    alert('The File APIs are not fully supported in this browser.');
}
