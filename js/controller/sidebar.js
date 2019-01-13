let $sidebar = (function() {

	function updateSidebar(item, subitem) {
		if (item == null) {
			return;
		}
		html = '';

		/*
		let text = $format.textOnly(subitem.data);

		text = text.replace('&nbsp;', ' ');

		if (text.length > 53) {
			text = text.substring(0, 53) + '...';
		}

		html += '<div style="color:black; font-style:italic; background-color:#dddddd; width:500px; height:40px; padding:10px;overflow-wrap: break-word;">'+text+'</div>';
		*/

		html += '<div style="height:25px;"></div>';

		html += '<hr>';

		/*
		html += '<div style="color:white; font-weight:bold; padding-top:7px; font-size:large;">Text</div>';
			
		html += '<div style="color:black; background-color:#dddddd; width:500px; padding:10px;overflow-wrap: break-word;">'+$format.toEscaped(subitem.data)+'</div>';
		*/

		if (subitem._direct_tags != undefined && subitem._direct_tags.length > 0) {
			html += '<div style="color:white; font-weight:bold; padding-top:7px; font-size:large;">Tags</div>';
			for (let tag of subitem._direct_tags) {
				html += '<div>'+tag+'</div>';
			}
		}
		if (subitem._numeric_tags != undefined && subitem._numeric_tags.length > 0) {
			html += '<div style="color:white; font-weight:bold; padding-top:7px; font-size:large;">Numeric tags</div>';
			for (let tag of subitem._numeric_tags) {
				html += '<div>'+tag+'</div>';
			}
		}
		if (subitem._inherited_tags != undefined && subitem._inherited_tags.length > 0) {
			html += '<div style="color:white; font-weight:bold; padding-top:7px; font-size:large;">Inherited tags</div>';
			for (let tag of subitem._inherited_tags) {
				html += '<div>'+tag+'</div>';
			}
		}
		if (subitem._implied_tags != undefined && subitem._implied_tags.length > 0) {
			html += '<div style="color:white; font-weight:bold; padding-top:7px; font-size:large;">Implied tags</div>';
			for (let tag of subitem._implied_tags) {
				html += '<div>'+tag+'</div>';
			}
		}
		$('#div_side_panel').html(html);
	}

	function clearSidebar() {
		$('#div_side_panel').html('');
	}

	return {
		updateSidebar: updateSidebar,
		clearSidebar: clearSidebar
	}

})();