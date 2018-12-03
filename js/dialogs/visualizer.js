let $visualizer = (function() {

    let processingInstance = null;

	function open_dialog(items, callback) {

        picoModal({
            content: 
                "<p style='font-weight:bold; margin:10px;'>Data Visualizer</p>" +
                "<div style='margin:10px;'>" +
                "<canvas id='my-canvas'> </canvas>" +
                "<br>" +
                "<button class='ok'>Okay</button>" +
                "</div>",
            closeButton: false
        }).afterCreate(modal => {
            modal.modalElem().addEventListener("click", evt => {
                if (evt.target && evt.target.matches(".ok")) {
                    modal.close();
                    //processingInstance.noLoop()
                }
            });
        }).afterShow(modal => {

             function sketchProc(processing) {
               // Override draw function, by default it will be called 60 times per second
               processing.draw = function() {
                 // determine center and max clock arm length
                 var centerX = processing.width / 2, centerY = processing.height / 2;
                 var maxArmLength = Math.min(centerX, centerY);
             
                 function drawArm(position, lengthScale, weight) {
                   processing.strokeWeight(weight);
                   processing.line(centerX, centerY,
                     centerX + Math.sin(position * 2 * Math.PI) * lengthScale * maxArmLength,
                     centerY - Math.cos(position * 2 * Math.PI) * lengthScale * maxArmLength);
                 }
             
                 // erase background
                 processing.background(224);
             
                 var now = new Date();
             
                 // Moving hours arm by small increments
                 var hoursPosition = (now.getHours() % 12 + now.getMinutes() / 60) / 12;
                 drawArm(hoursPosition, 0.5, 5);
             
                 // Moving minutes arm by small increments
                 var minutesPosition = (now.getMinutes() + now.getSeconds() / 60) / 60;
                 drawArm(minutesPosition, 0.80, 3);
             
                 // Moving hour arm by second increments
                 var secondsPosition = now.getSeconds() / 60;
                 drawArm(secondsPosition, 0.90, 1);
               };
             }
             
             var canvas = document.getElementById("my-canvas");
             processingInstance = new Processing(canvas, sketchProc);

        }).afterClose((modal, event) => {
            modal.destroy();
            callback();
        }).show();
	}

	return {
		open_dialog: open_dialog
	}
})();