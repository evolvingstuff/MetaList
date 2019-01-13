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
				html += '<div>'+formatSomeTags(tag)+'</div>';
			}
		}
		if (subitem._numeric_tags != undefined && subitem._numeric_tags.length > 0) {
			html += '<div style="color:white; font-weight:bold; padding-top:7px; font-size:large;">Numeric tags</div>';
			for (let tag of subitem._numeric_tags) {
				html += '<div>'+formatSomeTags(tag)+'</div>';
			}
		}
		if (subitem._implied_tags != undefined && subitem._implied_tags.length > 0) {
			html += '<div style="color:white; font-weight:bold; padding-top:7px; font-size:large;">Implied tags</div>';
			for (let tag of subitem._implied_tags) {
				html += '<div>'+formatSomeTags(tag)+'</div>';
			}
		}
		if (subitem._inherited_tags != undefined && subitem._inherited_tags.length > 0) {
			html += '<div style="color:white; font-weight:bold; padding-top:7px; font-size:large;">Inherited tags</div>';
			for (let tag of subitem._inherited_tags) {
				html += '<div>'+formatSomeTags(tag)+'</div>';
			}
		}
		$('#div_side_panel').html(html);
	}

	function clearSidebar() {
		$('#div_side_panel').html('');
	}

	function formatSomeTags(tag) {
		if (tag == '@bold') {
			tag = '<span style="font-weight:bold;">'+tag+'</span>';
		}
		if (tag == '@italics') {
			tag = '<span style="font-style:italics;">'+tag+'</span>';
		}
		if (tag == '@green') {
			tag = '<span style="color:green;">'+tag+'</span>';
		}
		if (tag == '@blue') {
			tag = '<span style="color:blue;">'+tag+'</span>';
		}
		if (tag == '@red') {
			tag = '<span style="color:red;">'+tag+'</span>';
		}
		if (tag == '@grey') {
			tag = '<span style="color:grey;">'+tag+'</span>';
		}
		if (tag == '@h1') {
			tag = '<span style="font-size:large;">'+tag+'</span>';
		}
		if (tag == '@h2') {
			tag = '<span style="font-size:large;">'+tag+'</span>';
		}
		if (tag == '@h3') {
			tag = '<span style="font-size:large;">'+tag+'</span>';
		}
		if (tag == '@h4') {
			tag = '<span style="font-size:large;">'+tag+'</span>';
		}
		if (tag == '@meta') {
			tag = '<span class="badge badge-light">'+tag+'</span>';
		}
		if (tag == '@macro') {
			tag = '<span class="badge badge-primary" style="background-color:green;">'+tag+'</span>';
		}
		if (tag == '@todo') {
			tag = '<span><i class="glyphicon glyphicon-unchecked"></i>&nbsp;'+tag+'</span>';
		}
		if (tag == '@done') {
			tag = '<span><i class="glyphicon glyphicon-check"></i>&nbsp;'+tag+'</span>';
		}
		if (tag == '@goto-search') {
			tag = '<i class="glyphicon glyphicon-link"></i>&nbsp;<span">'+tag+'</span>';
		}
		if (tag == '@code') {
			tag = '<span class="copyable"><code>'+tag+'</code></span>';
		}
		if (tag == '@fold') {
			tag = '<span><i class="glyphicon glyphicon-menu-up"></i>&nbsp;'+tag+'</span>';
		}
		if (tag == '@unfold') {
			tag = '<span><i class="glyphicon glyphicon-menu-down"></i>&nbsp;'+tag+'</span>';
		}
		if (tag == '@date-headline') {
			tag = '<span class="glyphicon glyphicon-calendar"></span>&nbsp;'+tag;
		}
		return tag;
	}

	return {
		updateSidebar: updateSidebar,
		clearSidebar: clearSidebar
	}

})();