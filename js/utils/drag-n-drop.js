'use strict';
//https://gist.github.com/andjosh/7867934
if (window.File && window.FileReader && window.FileList && window.Blob) {
    function handleJSONDrop(evt) {
        //console.log('handleJSONDrop()');
        evt.stopPropagation();
        evt.preventDefault();
        let files = evt.dataTransfer.files;
        // Loop through the FileList and read
        for (let i = 0; i < files.length; i++) {
            let f = files[i];
            // Only process json files.
            //console.log(f);
            //check for name ending with .json
            let reader = new FileReader();
            // Closure to capture the file information.
            reader.onload = (function (theFile) {
                return function (e) {
                    let data = JSON.parse(e.target.result);
                    $todo.restore(data);
                    alert('Successfully loaded from *.json backup file!');
                };
            })(f);
            reader.readAsText(f);
        }
    }
    function handleDragOver(evt) {
        //console.log('handleDragOver()');
        evt.stopPropagation();
        evt.preventDefault();
        evt.dataTransfer.dropEffect = 'copy'; // Explicitly show this is a copy.
    }
    // Setup the dnd listeners.
    let dropZone = document.getElementById('div_load');
    dropZone.addEventListener('dragover', handleDragOver, false);
    dropZone.addEventListener('drop', handleJSONDrop, false);
}
else {
    alert('The File APIs are not fully supported in this browser.');
}
