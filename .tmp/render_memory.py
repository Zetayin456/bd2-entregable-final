import json, subprocess, sys, re
from pathlib import Path
from xml.sax.saxutils import escape
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, PageBreak, Table, TableStyle, ListFlowable, ListItem, Preformatted, KeepTogether, NextPageTemplate)
from reportlab.platypus.tableofcontents import TableOfContents

root=Path.cwd(); source=root/'docs/MEMORIA_FINAL.md'; output=root/'output/pdf/Memoria_Final_Proyecto_15.pdf'
data=json.loads(subprocess.check_output(['pandoc',str(source),'-t','json'], text=True, encoding='utf-8'))
meta=data['meta']
def meta_text(key):
    obj=meta.get(key,{}); typ=obj.get('t')
    if typ=='MetaInlines': return inline(obj['c'])
    if typ=='MetaString': return obj['c']
    if typ=='MetaList': return ', '.join(inline(x.get('c',[])) for x in obj['c'])
    return ''

def inline(nodes):
    out=[]
    for node in nodes:
        t=node['t']; c=node.get('c','')
        if t=='Str': out.append(escape(c))
        elif t in ('Space','SoftBreak'): out.append(' ')
        elif t=='LineBreak': out.append('<br/>')
        elif t=='Emph': out.append('<i>'+inline(c)+'</i>')
        elif t=='Strong': out.append('<b>'+inline(c)+'</b>')
        elif t=='Strikeout': out.append('<strike>'+inline(c)+'</strike>')
        elif t in ('Superscript','Subscript'): out.append('<super>'+inline(c)+'</super>' if t=='Superscript' else '<sub>'+inline(c)+'</sub>')
        elif t=='Code': out.append('<font name="Courier">'+escape(c[1])+'</font>')
        elif t=='Quoted': out.append('&ldquo;'+inline(c[1])+'&rdquo;')
        elif t=='Link':
            target=c[2][0]
            out.append('<link href="'+escape(target, {'"':'&quot;'})+'" color="#1256a0">'+inline(c[1])+'</link>')
        elif t=='Math': out.append(escape(c[1]))
        elif t=='Cite': out.append(inline(c[1]))
        elif t=='Span': out.append(inline(c[1]))
        elif t=='RawInline': continue
        else: out.append(inline(c) if isinstance(c,list) else escape(str(c)))
    return ''.join(out)

styles=getSampleStyleSheet()
styles.add(ParagraphStyle(name='BodyAPA', parent=styles['BodyText'], fontName='Times-Roman', fontSize=12, leading=24, alignment=TA_LEFT, spaceAfter=12, firstLineIndent=36))
styles.add(ParagraphStyle(name='NoIndent', parent=styles['BodyAPA'], firstLineIndent=0))
styles.add(ParagraphStyle(name='Reference', parent=styles['BodyAPA'], leftIndent=36, firstLineIndent=-36, spaceAfter=12))
styles.add(ParagraphStyle(name='H1APA', parent=styles['Heading1'], fontName='Times-Bold', fontSize=12, leading=16, spaceBefore=0, spaceAfter=16, keepWithNext=True))
styles.add(ParagraphStyle(name='H2APA', parent=styles['Heading2'], fontName='Times-Bold', fontSize=12, leading=16, spaceBefore=12, spaceAfter=8, keepWithNext=True))
styles.add(ParagraphStyle(name='H3APA', parent=styles['Heading3'], fontName='Times-BoldItalic', fontSize=12, leading=16, spaceBefore=8, spaceAfter=6, keepWithNext=True))
styles.add(ParagraphStyle(name='TableCellAPA', parent=styles['BodyText'], fontName='Times-Roman', fontSize=9.5, leading=12, spaceAfter=0))
styles.add(ParagraphStyle(name='TableHeadAPA', parent=styles['TableCellAPA'], fontName='Times-Bold'))
styles.add(ParagraphStyle(name='CodeAPA', parent=styles['Code'], fontName='Courier', fontSize=9, leading=12, leftIndent=18, rightIndent=18, spaceBefore=6, spaceAfter=8))
styles.add(ParagraphStyle(name='TitleAPA', parent=styles['Title'], fontName='Times-Bold', fontSize=16, leading=22, alignment=TA_CENTER, spaceAfter=24))
styles.add(ParagraphStyle(name='SubtitleAPA', parent=styles['BodyText'], fontName='Times-Roman', fontSize=12, leading=24, alignment=TA_CENTER, spaceAfter=16))
styles.add(ParagraphStyle(name='TOCTitleAPA', parent=styles['Heading1'], fontName='Times-Bold', fontSize=12, leading=16, spaceAfter=14))

class MemoryDoc(BaseDocTemplate):
    def __init__(self, filename, **kwargs):
        super().__init__(filename, **kwargs)
        frame=Frame(self.leftMargin,self.bottomMargin,self.width,self.height,id='normal',leftPadding=0,rightPadding=0,topPadding=0,bottomPadding=0)
        self.addPageTemplates([PageTemplate(id='main',frames=[frame],onPage=self.footer)])
    def footer(self,canvas,doc):
        if doc.page>1:
            canvas.saveState(); canvas.setFont('Times-Roman',9)
            canvas.drawString(doc.leftMargin,0.55*inch,'Proyecto 15 | Memoria técnica')
            canvas.drawRightString(A4[0]-doc.rightMargin,0.55*inch,str(doc.page))
            canvas.restoreState()
    def afterFlowable(self,flowable):
        if isinstance(flowable,Paragraph) and getattr(flowable,'_toc_level',None) is not None:
            level=flowable._toc_level; text=flowable.getPlainText(); key='h%s-%s'%(level,self.seq.nextf('heading'))
            self.canv.bookmarkPage(key); self.canv.addOutlineEntry(text,key,level=level,closed=False)
            self.notify('TOCEntry',(level,text,self.page,key))

# Page size and APA-like one-inch margins; body text uses 12pt Times Roman and double leading.
doc=MemoryDoc(str(output),pagesize=A4,leftMargin=inch,rightMargin=inch,topMargin=inch,bottomMargin=inch,title=meta_text('title'),author=meta_text('author'))
story=[]
story += [Spacer(1,1.4*inch), Paragraph(escape(meta_text('title')),styles['TitleAPA']), Paragraph(escape(meta_text('subtitle')),styles['SubtitleAPA']), Spacer(1,0.5*inch), Paragraph(escape(meta_text('author')),styles['SubtitleAPA']), Paragraph(escape(meta_text('date')),styles['SubtitleAPA']), Spacer(1,0.8*inch), Paragraph('Datos institucionales y de autoría individual: no constan en el material del repositorio.',styles['SubtitleAPA']), PageBreak()]
story.append(Paragraph('Contenido',styles['TOCTitleAPA']))
toc=TableOfContents(); toc.levelStyles=[ParagraphStyle(name='TOC0',fontName='Times-Roman',fontSize=11,leading=18,leftIndent=0,firstLineIndent=0),ParagraphStyle(name='TOC1',fontName='Times-Roman',fontSize=10,leading=15,leftIndent=18,firstLineIndent=0)]
story.extend([toc,PageBreak()])
blocks=data['blocks']; skipped_cover=False; in_refs=False

def para_text(blocks): return inline(blocks)
def cell_blocks(cell): return para_text(cell[4])
def row_cells(row): return [cell_blocks(c) for c in row[1]]
def table_flow(block):
    c=block['c']; header_rows=c[3][1]; rows=[]
    for row in header_rows: rows.append([Paragraph(v,styles['TableHeadAPA']) for v in row_cells(row)])
    for body in c[4]:
        for row in body[3]: rows.append([Paragraph(v,styles['TableCellAPA']) for v in row_cells(row)])
    widths=[doc.width/5]*5 if rows and len(rows[0])==5 else None
    tb=Table(rows,colWidths=widths,repeatRows=1,hAlign='LEFT')
    tb.setStyle(TableStyle([('LINEABOVE',(0,0),(-1,0),1,colors.black),('LINEBELOW',(0,0),(-1,0),0.7,colors.black),('LINEBELOW',(0,-1),(-1,-1),1,colors.black),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),4),('RIGHTPADDING',(0,0),(-1,-1),4),('TOPPADDING',(0,0),(-1,-1),5),('BOTTOMPADDING',(0,0),(-1,-1),5)]))
    return tb

def blocks_to_flow(items, list_depth=0):
    global in_refs
    result=[]
    for b in items:
        t=b['t']; c=b.get('c')
        if t=='RawBlock': continue
        if t=='Header':
            level=c[0]; title=inline(c[2]); plain=re.sub('<[^>]+>','',title)
            if level==1 and plain.startswith('1. Portada'):
                skipped_cover=True
                continue
            if level==1 and plain.startswith('2. Resumen'): result.append(PageBreak())
            elif level==1: result.append(PageBreak())
            style=styles['H1APA'] if level==1 else styles['H2APA'] if level==2 else styles['H3APA']
            p=Paragraph(title,style); p._toc_level=0 if level==1 else 1 if level==2 else None
            result.append(p)
            if plain=='Referencias': in_refs=True
            elif plain.startswith('Apéndice A'): in_refs=False
        elif t in ('Para','Plain'):
            text=para_text(c)
            if not text.strip(): continue
            if text.startswith('**Palabras clave:**'):
                text=text.replace('<b>Palabras clave:</b>','<b>Palabras clave:</b>',1)
                result.append(Paragraph(text,styles['NoIndent']))
            else: result.append(Paragraph(text,styles['Reference'] if in_refs else styles['BodyAPA']))
        elif t=='Table': result.append(Spacer(1,6)); result.append(table_flow(b)); result.append(Spacer(1,10))
        elif t=='BulletList':
            itemsflow=[]
            for item in c:
                item_story=blocks_to_flow(item,list_depth+1)
                itemsflow.append(ListItem(item_story,leftIndent=12))
            result.append(ListFlowable(itemsflow,bulletType='bullet',start='circle',leftIndent=24+list_depth*12,bulletFontName='Times-Roman',bulletFontSize=10,spaceAfter=8))
        elif t=='OrderedList':
            for n,item in enumerate(c[1],1):
                result.append(Paragraph(str(n)+'.',styles['NoIndent'])); result.extend(blocks_to_flow(item,list_depth+1))
        elif t=='CodeBlock': result.append(Preformatted(c[1],styles['CodeAPA']))
        elif t=='BlockQuote': result.extend(blocks_to_flow(c, list_depth))
        elif t=='HorizontalRule': result.append(Spacer(1,8))
        elif t=='Div': result.extend(blocks_to_flow(c[1],list_depth))
    return result

story.extend(blocks_to_flow(blocks))
doc.multiBuild(story)
print(f'PDF={output} SIZE={output.stat().st_size}')



