"use strict";

//https://gist.github.com/andjosh/7867934
if (window.File && window.FileReader && window.FileList && window.Blob) {

    function handleDrop(evt) {

        if ($main_controller.itemIsSelected()) {
            return;
        }

        evt.stopPropagation();
        evt.preventDefault();

        let url = evt.dataTransfer.getData("URL");
        if (url !== '') {
            $main_controller.actionAddLink(evt, url);
            return;
        }

        let files = evt.dataTransfer.files;
        for (let i = 0; i < files.length; i++) {
            let f = files[i];
            //TODO: Only process json files.
            let reader = new FileReader();
            reader.onload = (function (theFile) {
                return function (e) {
                    if (f.name.endsWith('.json')) {
                        let data = JSON.parse(e.target.result);
                        $main_controller.restoreFromFile(data);
                    }
                    else {
                        alert('Unknown file type ' + f.name);
                    }
                    
                };
            })(f);
            reader.readAsText(f);
        }
    }

    function handleDragOver(evt) {

        if ($main_controller.itemIsSelected()) {
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
