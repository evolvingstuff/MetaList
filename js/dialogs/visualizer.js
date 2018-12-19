let $visualizer = (function() {

    let processingInstance = null;



	function open_dialog(items, callback) {

        let filtered_items = [];
        for (let item of items) {
            if (item.subitems[0]._include == 1) {
                filtered_items.push(item);
            }
        }
        //console.log(filtered_items.length + ' filtered items');
        let data_streams = {};
        let keys = [];
        let has_data = false;
        for (let item of filtered_items) {
            for (let subitem of item.subitems) {
                if (subitem._include != 1) {
                    continue;
                }
                if (subitem._numeric_tags != undefined && subitem._numeric_tags.length > 0) {
                    console.log(JSON.stringify(subitem._numeric_tags));
                    for (let tag of subitem._numeric_tags) {
                        let parts = tag.split("=");
                        let name = parts[0];
                        let val = parts[1]
                        if (data_streams[name] == undefined) {
                            data_streams[name] = [];
                            has_data = true;
                            keys.push(name);
                        }
                        data_streams[name].push({"value":val, "timestamp":item.timestamp});
                    }
                }
            }
        }

        if (has_data == false) {
            alert('No numeric data in view for visualization');
            callback();
            return;
        }

        function updateSelection(unit) {
            let max_timestamp = 0;
            let max_value = -10000000;
            for (let entry of data_streams[unit]) {
                max_timestamp = Math.max(max_timestamp, entry.timestamp);
                max_value = Math.max(max_value, entry.value);
            }
            let min_timestamp = max_timestamp;
            let min_value = max_value;
            for (let entry of data_streams[unit]) {
                min_timestamp = Math.min(min_timestamp, entry.timestamp);
                min_value = Math.min(min_value, entry.value);
            }

            data_streams[unit].sort(function(a, b) {
                return a.timestamp - b.timestamp;
            });

            for (let entry of data_streams[unit]) {
                console.log('\t'+JSON.stringify(entry));
            }

            function sketchProc(processing) {
               // Override draw function, by default it will be called 60 times per second

               processing.setup = function() {
                 processing.size(500, 500);
               }

               processing.draw = function() {

                processing.background(224);

                processing.strokeWeight(2);

                for (let i = 0; i < data_streams[unit].length-1; i++) {
                    let a = data_streams[unit][i];
                    let b = data_streams[unit][i+1];
                    let xa_blend = (a.timestamp - min_timestamp) / (max_timestamp - min_timestamp);
                    let ya_blend = (a.value - Math.min(0, min_value)) / (max_value - Math.min(0, min_value));
                    let xb_blend = (b.timestamp - min_timestamp) / (max_timestamp - min_timestamp);
                    let yb_blend = (b.value - Math.min(0, min_value)) / (max_value - Math.min(0, min_value));

                    console.log('\txa = ' + xa_blend + ' / xb = ' + xb_blend);
                    console.log('\t\tya = ' + ya_blend + ' / yb = ' + yb_blend);

                    padW = 10;
                    padH = 10;

                    let W = processing.width;
                    let H = processing.height;
                    let x1 = xa_blend*(W-2*padW)+padW;
                    let x2 = xb_blend*(W-2*padW)+padW;
                    let y1 = (1-ya_blend)*(H-2*padH)+padH;
                    let y2 = (1-yb_blend)*(H-2*padH)+padH;

                    processing.line(x1, y1, x2, y2);

                }
                 this.noLoop();
               };
             }

            var canvas = document.getElementById("my-canvas");
            processingInstance = new Processing(canvas, sketchProc);
        }

        let options = '';
        for (let key of keys) {
            options += "<option value='"+key+"'>"+key+"</option>";
        }

        picoModal({
            content: 
                "<p style='font-weight:bold; margin:10px;'>Numeric Data Visualizer</p>" +
                "<div style='margin:10px;'>" +
                "<select id='sel_visualization_units'>" + options + "</select>" +
                "<br>" +
                "<br>" +
                "<canvas id='my-canvas'> </canvas>" +
                "<br>" +
                "<br>" +
                "<button class='ok'>Okay</button>" +
                "</div>",
            closeButton: false
        }).afterCreate(modal => {

            $('#sel_visualization_units').on('change', function(e) {
                let unit = $(e.currentTarget).val();
                updateSelection(unit);
            });

            

            //TODO: render first


            modal.modalElem().addEventListener("click", evt => {
                if (evt.target && evt.target.matches(".ok")) {
                    modal.close();
                }
            });
        }).afterShow(modal => {

            let unit = $('#sel_visualization_units').val();
            updateSelection(unit);

        }).afterClose((modal, event) => {
            modal.destroy();
            callback();
        }).show();
	}

	return {
		open_dialog: open_dialog
	}
})();