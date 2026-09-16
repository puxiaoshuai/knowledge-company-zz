当前项目是我做企业知识库的项目。目前正在搭建

目前实现的功能，上传文件pdf,docx等文件能进行解析并存储。
原数据存储到了 postgresql , markdown正文存储到了mongodb.

然后实现了 发布文档的功能，发布之后，
1.数据异步存储到 Es kh_chunk  .已实现
2.数据 存储到es进行全文搜索   todo
3.分块抽取实体关系 todo