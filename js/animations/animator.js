let $animator = (function() {

	let mode_graphics_test = false;
	let canvas = document.getElementById('animation-canvas');
	let ctx = canvas.getContext('2d');

	$('#animation-canvas').show();

	function draw(src_item, target_item) {

		console.log('$$$ ' + src_item.id + ' -> ' + target_item.id);
		let el1 = getItemElementById(src_item.id);
		let el2 = getItemElementById(target_item.id);
		ctx.clearRect(0, 0, canvas.width, canvas.height);

		let vert_offset = 9;

		let y1 = $(el1).position().top + $(el1).height()/2;
		let y2 = $(el2).position().top + $(el2).height()/2;

		//ctx.strokeRect(50, 50, 50, 50);

		ctx.fillStyle = "#000000";

		if (y1 == y2) {
			ctx.fillRect(842, y1-vert_offset, 11, 2);
			ctx.fillRect(847, y1-vert_offset-3, 8, 8);
		}
		else {

			if (y1 < y2) {
				y2 = $(el2).position().top+$(el2).height();
			}
			else {
				y2 = $(el2).position().top-1;
			}

			ctx.fillRect(842, y1-vert_offset, 15, 2);
			ctx.fillRect(842, y2-vert_offset, 15, 2);
			ctx.fillRect(855, Math.min(y1, y2)-vert_offset, 2, Math.abs(y1-y2));

			ctx.fillRect(842, y2-vert_offset-3, 8, 8);

			ctx.globalAlpha = 0.15;
			ctx.fillStyle = "#3333DD";
		    ctx.fillRect(4,$(el1).position().top-14,839,$(el1).height()+12);
		    ctx.fillRect(4,$(el2).position().top-14,839,$(el2).height()+12);
		    ctx.fillStyle = "#000000";
		    ctx.globalAlpha = 1.0;
		}
    }

	function test1(src_item, target_item) {
		if (src_item.id == target_item.id) {
			endTest1();
			return;
		}

		clearSelection();

		//console.log(el);
		if (mode_graphics_test == false) {
	        mode_graphics_test = true;
	        $('#animation-canvas').show();
    	}
    	draw(src_item, target_item);
	}

	function endTest1() {
		mode_graphics_test = false;
		
		$('#animation-canvas').hide();
	}

	return {
		test1: test1,
		endTest1: endTest1
	}

})();