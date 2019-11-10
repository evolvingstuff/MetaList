/* jsyn - ultralight syntax highlighter; Jim Palmer - jimpalmer@gmail.com; released under MIT License */
var jsyn = function () {
	this.nodes = document.getElementsByTagName('pre');
	/* language definitions */
	var types = {common:{
			k:'break,case,catch,class,continue,delete,do,else,for,function,if,in,instanceof,new,private,protected,public,return,switch,throw,throw,try,typeof,var,watch,while',
			d:'array,bool,boolean,date,datetime,decimal,false,float,hashtable,int,int32,nan,null,string,true',
			c:/(?:\/\*(.|[\n\r])*?\*\/)|(?:\/\/[^\n\r]+[\n\r])|(?:<![-]{2,3}([\s\S](?!>))+[-]{2,3}>)/
		},sql:{
			k:'alter,begin,by,commit,create,delete,drop,exec,from,group,having,insert,join,like,on,order,rollback,select,set,table,transaction,trigger,truncate,union,update,values,where',
			d:'and,asc,between,desc,distinct,exists,inner,left,or,outer,right,top',
			c:/(?:\/\*(.|[\n\r])*?\*\/)|(?:--[^\n\r]+[\n\r])/
		},python:{
			k:'and,as,assert,break,class,continue,def,del,elif,else,except,exec,finally,for,from,global,if,import,in,is,lambda,not,or,pass,print,raise,return,try,while,with,yield',
			d:'int,str,types',
			c:/(?:#[^\n\r]+[\n\r])/
		}},dtab = 8;
	for (var node in this.nodes) {
		var n = this.nodes[node],cnc = 0,cnl = ( n.childNodes != null ? n.childNodes.length : 0 ),is = n.nodeValue || '';
		// limit to 'pre.code' selector and non-jsyn()'d blocks
		if ((n.className || '' ).indexOf('code') < 0 || (n.className || '' ).indexOf('jsyn') >= 0) continue; 
		for (;cnc < cnl; cnc++) is += n.childNodes.item(cnc).nodeValue; // capture all the content in the 'pre.code'
		var ext = new Date(),os = [],rec = 0,re = [],pi = 0,a = true,sl = is.length,c = 0,ct = types.common,
			tabs = parseInt((n.className.match(/tab([0-9]+)/) || [])[1]) || dtab;
		// find first language definition in className - otherwise default to 'common'
		for (var ty in types) if (n.className.indexOf(ty) >= 0) { ct = types[ty]; break; } // console.log(ty);
		// build the language specific tokenizers
		var r = [{c:'c',r:ct.c}, // comments
				{c:'s',r:/(?:\/\S+\/)|(?:'(?:\\'|[^'])*')|(?:"(?:\\"|[^"])*")/}, // regexp,strings
				{c:'n',r:/(?:\d+\.?\d*[%f]?)/}, // numbers
				{c:'k',r:(new RegExp('(?:'+ ct.k.split(',').join('\\s)|(?:') +')'))}, // keywords
				{c:'d',r:(new RegExp('(?:'+ ct.d.split(',').join('\\s)|(?:') +')'))}, // datatypes
				{c:'f',r:/(?:[\\\[\]\(\)\{\}:\#\@\+\-\=\*\%\&\|\.]+)|(?:==|>=|<=|!=|<<|>>)/}, // flow operators
				{c:'w',r:/(?:[A-Za-z_-]\w*)/}, // word (variables)
				{c:'t',r:(new RegExp(( tabs == dtab ? '' : '(?:\t)' )))} // reformatted tabs
				],rel = r.length;
		// build the tokenizing regexp
		for (;rec < rel;rec++) re.push( ( ( rec && r[rec].r.source ) ? '|' : '' ) + r[rec].r.source );
		for (var t = new RegExp(re.join(''),'gmi'); c < sl && (a = t.exec(is)); c++) // iterate rexexp.exec tokens
			for (rec = 0; rec < rel; rec++) // loop through each regexp type to match on token
				if (r[rec].r.source && r[rec].r.test(a[0])) { // modify token if matched on any regexp 
					// tab manipulation if not default
					if (tabs != dtab && r[rec].c == 't')
						var mp = t.lastIndex - a[0].length - 1,
							rn = Math.max(is.lastIndexOf('\r', mp), is.lastIndexOf('\n', mp))
							to = tabs - ( ( mp - Math.max(is.lastIndexOf('\t', mp), rn) ) % tabs );
					// innerHTML method - wrap found token in appropriately matched regexp type
					os.push( is.substring(pi,(t.lastIndex - a[0].length)).replace(/</g,'&lt;').replace(/>/g,'&gt;') +
						'<b class="'+ r[rec].c + ( r[rec].c == 't' && parseInt(to) != tabs ? to : '') +'">'+
						a[0].replace(/</g,'&lt;').replace(/>/g,'&gt;') +'</b>' );
					pi = t.lastIndex;
					break;
				}
		// update the newly build innerhtml (pre needed to render in IE6 properly)
		n.innerHTML = (/msie/i.test(navigator.userAgent) ? '<pre>' : '') + os.join('') + is.substring(pi,sl) + ((new Date()).getTime() - ext.getTime()) +'ms'+ (/msie/i.test(navigator.userAgent) ? '</pre>' : '');
		n.className += ( n.className ? ' ' : '' ) + 'jsyn';
	}
	return true;
};

// document.attachEvent && document.attachEvent("onreadystatechange", /* IE DOM ready*/
// 	function(e){ document.readyState === "complete" && jsyn() && document.detachEvent(e.type, arguments.callee); }) || 
// document.addEventListener && document.addEventListener("DOMContentLoaded", /* !IE DOM ready */
// 	function(e){ jsyn() && document.removeEventListener(e.type, arguments.callee, false); }, false);
