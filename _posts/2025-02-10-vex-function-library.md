---
layout: post
title: Vex Function  Library
subtitle: 一些整理的Vex Function 笔记
author: KW
header-style: text
tags:
  - Houdini
  - TA
---
1800+ 行的函数总结，大部分解释都写在注释了。

后续有内容还会更新。

{% highlight csharp %}
// ----------------------------------------------------
// random 的法线。 可以通过在curlnoise函数中 来影响法线，或者直接影响@P, 结果是完全不同的下过
vector o = chv("O");
float amp = chf("amp");
vector f = chv("f");
//-----------------------------------------------------


//创建对应的变量

vector n  = curlnoise(@P * f + o) * amp; //直接加到函数中
vector n  = curlnoise(@P * f) + o；//计算完noise 之后再做偏移
v@N = normalize(n);// 计算完影响到法线，copytopoins 效果则是通过噪声动画影响发现，物体会随着发现改变而旋转
@P += n;//计算完影响到当前点的左边，copytopoins则是来实现噪声使得左边点进行上下的运动
// ----------------------------------------------------


//两个向量相减，谁减谁，看向谁
int npt = nearpoint(1, @P);
vector npos = point(1, "P", npt);
float dist = distance(@P, npos);
vector dir = npos - v@P;
//-------------------------------------------------------


//foor loop 画一个圆
for(float anlge = 0; angle < 2 * PI; angle += chf("step")){
     vector pos;
     float x = cos(angle);
     float y = sin(angle)；
     float z = cos(angle); //可以设置为0
     pos = set(x, y, z);
     int npt = addpoint(0, pos);
}
//-------------------------------------------------------



//随机左右创建
vector pos;
float f;
int max  = chi("maxiter");

for(int i = 0; i < max; i ++){
    float chance = rand(i);
    float it = nrandom();
    float y = 0;
    float z = 0;
    float x = i;
    //y pos random
    if(chance > it){
         z = 1;
    }
    else {
        z = -1;
    }

    int newprim = addprim(0, "polyline");
    pos = set(x, y, z);
    int newpt  = addpoint(0, pos);
    addvertex(0, newprim, newpt);
    setpointattrib(0, "chance", newpt, chance, "set");

}
//-------------------------------------------------------
// 数组的pop / push / append / len / resize / reorder/  argsort
// removeindex / removevalue/ reverse / slice  / find


pop(array, index)；//后面的index 输入就是删掉第几个位置的内容
push(array, values)；// 吧数值推入到数组的最后一位，同时增加一个数组长度
append(array, value) //同push 即 会按照append的顺序排列被推入的数组
len(array);//返回数组的长度
resize(array, size);// 重新设置对应数组的长度。如果新给的长度大于原有的长度，则为空，或者0

int my_array[] = i[]@my_array;
resize(my_array, 1);
i[]@my_array = my_array;

reorder(value, indices);//按照后面的数组进行重新排序
//根据字符串长度进行重新排序
string colors[] = {"red", "blue", "drack", "blackwith"};
int length[] = {};
foreach (string name;  colors){
    /* code */
    push(length, len(name));
}
int reording[] = argsort(length);// 针对字符串长度进行大小排序
string colors_by_length[] = reorder(colors, reording);// 使用reorder 进行重新排序按照后面的数组顺序

removeindex(npt, 0);// 负数的index 为从数组的末端开始计算，比如 -2 即为吧数组后面的第二位删掉


float nums[] = {0, 1, 2, 3, 1, 2, 3};//删除对应的值，只会删除数组中第一个符合都值，返回1 或者0
removevalue(nums; 2);  // == 1
// nums == {0, 1, 3, 1, 2, 3}

slice(s[], start, end)

int[] nums = {10, 20, 30, 40, 50, 60};
slice(nums, 1, 3) == {20, 30};  // nums[1:3]
slice(nums, 1, -1) == {20, 30, 30, 40, 50};  // nums[1:-1]
slice(nums, 0, len(nums), 2) == {20, 40, 60};  // nums[0:len(nums):2]
slice(nums, 0, 0, 0, 0, 1, 2) == {20, 40, 60};
//切开一个数组，从开始和结束，都为index

//find array 可以在一个数组中找到对应的元素。
int find(array, search, start, end)//可以定义从array中那个开始到那个index 去寻找相关的元素
int myint = 0;
int frames[] = {1, 24, 55, 66};//创建一个需要改变都数组
if(find(frames, @Frame) >= 0){//判断如果当前帧的数值能走在上面的数组中找到，即大于等于0 则执行下面的代码
    myint  = 1 ;
}
//---------------------------------------------------------------------


//--------------------------------------------------------------------
//nearpoint , nearpoints, pcopen, pcfind, 函数使用
int npt = nearpoint(geometry, pt, maxdist);
//如果npt连接的是geometry 1 ，那么他返回的则是slot 1 的geo 上的点的信息，所以如果想要对他进行操作，则需要point函数来访问对应点上的属性
int npts[] = nearpoints(geometry, pt, maxdist, maxpts);
//这是通过一个距离返回所有在这个距离之内的临近的点的数组。

int npts[] = pcfind(filename, Pchannel, P, radius, maxpoints);
//pchannel 可以获得的属性可以很多，可以根据不同的属性来判断。
int npts[] = pcfind_radius(filename,,"P", RadChannel, radscale, v@P, radius, maxpoints);
// radchannel 可以改成 pscale, custom attrib 等属性，可以通过radscale 来进行扩张影响



int handle = pcopen(filename, Pchannel, P, Nchannel, N, radius, maxpoints, ...)
//pcopen 还可以访问的数据不仅仅是P 坐标，可以访问所有点的信息。列入Cd, N 等。
//仿AO的效果制作
int handle = pcopen(0, "P", v@P, maxdist, maxpoint);
vector pcn = normalize(pcfilter(0, "N");
vector norm = normalize(v@N);
float dot = dot(norm, pcn);
@Cd = fit(dot, -1, 1, 0, 1);
@Cd = pow(dot, chf("gama"));
//---------------------------------------------------------------------------
int handle = pcopen(0, "Cd", @Cd, radius, maxpoints);
@P = pcfilter(handle, "P");
//------------------------------------------------------

//返回的是一个.pc的文件，点云可以储存对应的点的所有信息，
//使用的方式有 pcunshaded, pciterate, pcfilter, pcimpor, pcclose
//pcunshaded  和 pciterate 相似，但是pcunshaded 访问的是还没有被写入数据的数组
pcunshaded(handle, channel_name);
//通常使用whileloop 来进行循环，可以通过这个循环创建新的数据到点云中
int handle = pcopen(1, "P", v@P, maxdist, maxpt);
while(pcunshaded(handle, "attrib")){
    pcimport(handle, "P", p);
    pcimport(handle, "N", N);

    float dist = distance(P, N);

    pcexport(handle, "attrib", dist);
}
//首先通过pcunshaded 判断没有被写入attrib 的点， 然后通过pcimport 把点中的数据导出来，经过计算在 导出到 点上

while(pciterate(handle)){
    pcimport(handle, "attrib", attrib);
    //可以通过pciterate 再次进行循环操作，吧创建好的attrib数据导入进来
}
// 这里就是 pcunshaded pciterate pcimport, pcexport 的方法。
void pcexport(handle, channel_name, value, radius, ...); //  这里的还可以设置一个距离，控制导出的数据在这个距离范围之内


type pcfilter(handle, channel_name, ...);
//pcfilter 则是通过重建数据，意味着，原有的数据将会被清空。 同时返回要导出的数据类型。如 vector  "Cd"
int handle = pcopen(1, "P", v@P, maxdist, maxpt);
@Cd = pcfilter(hanlde, "Cd");
//输入1种原有的颜色会被清空，值保留查询到的新的hanlde中的点的颜色信息。

pcgenerate(filename, npoints);
//创建一个空的点云，可以自定义一个空的点云，然后在吧数据传输进去
vector position;
int ohandle, ghandle, rval;
ghandle = pcgenerate(texturename, npoints);
while(pcunshaded(ghandle), "P"){
    //compute Position
    rval = pcexport(ghandle, "P", position);
}
ohandle = pcopen(texturename, "P", P, maxdist, maxpt);
while(pciterate(ohandle)){
    rval = pcimport(ohandle, "P", position)

}
pcclose(ohandle);
pcclose(ghandle);
//----------------------------------------------------------------




//----------------------------------------------------------------------
//寻找两个点之间的直线向量创建线
int npts[] = nearpoints(0, v@P, maxdist, maxpt);
removeindex(npts, 0);//nearpoints 数组中会返回包括自己。 所以从0号线移除掉

foreach(int npt; npts){
     vector npos = point(0, "P", npt);

     float xdist = abs(v@P.x - npos.x);//  从x轴上 用自己的左边减去临点的x坐标，比较两个左边之间的差值是否小于一个值
     float ydist = abs(v@P.y - npos.y);
     float zdist = abs(v@P.z - npos.z);

     if(xdist < 0.001 && ydist < 0.001 || xdist < 0.001 && zdist < 0.001 || ydist < 0.001 && zdist < 0.001){
         addprim(0, "polyline", @ptnum, npt);
     }//如果有两个坐标的差值同时小于一个临界值，那么这两个向量具备共线性

}
//----------------------------------------------------------------------------
//在两点之间计算一个随机点
float cutalpha = fit01(rand(@ptnum), 0.1, 0.9);
vector cutpos = lerp(posa, posb, cutalpha);

//随机生成一个浮点数，然后fit 到0.1 到0.9 之间的数值 通过lerp 函数，来选择在两个pos之间的距离
//----------------------------------------------------------------------------

//-----------------------------------------------------------------------------
//获得boundingbox的函数 getbbox, getbbox_size, getbbox_min, getbbox_max, getbbox_center, getpointbbox
getbbox(geometry, &min, &max);
//返回2个向量，min, 和 max 分别是这个模型的bbox 最大值和最小值得点的坐标
getbbox_center(filename, primgroup)
//如果后面给一个组的话，中心点的位置就在这个组的中心
getbbox_size(filename, primgroup);
//返回一个向量包含着这个boundingbox的长度，宽度，高度
getpointbbox(0, &min, &max);
//只能用作于点的bbox 获取
//-----------------------------------------------------------------------------------

//-------------------------------------------------------------------------------
//随机在边界上寻找一个点，然后做垂直创建新的点 subdivid 在primitives 上运行，每一次循环针对每一个面执行。
int npts[] = primpoint(0, @primnum); //先要获得一个面上的所有的点的数组。
string grp = itoa(@primnum);//每个面都会创建一个对应的组，基于当前面的数子

vector bmax;
vector bmin;

getbbox(0, grp, bmin, bmax);//选择对应面的bounding box的大小
vector size = getbbox_size(0, grp);//获取对应面的bounding size

int curdir;
if(bbsize.x > bbsize.z){
    curdir = 0;
}
else{
    curdir = 1;
}
//判断下那个边更长，则选择在那个边上进行切割
float cutalpha = fit01(rand(@ptnum), 0.1, 0.9);
vector cutpos = lerp(bmin, bmax, cutalpha);
//计算在bbox两个点直接的斜线上的随机一个点，作为cut 点
int newprim = addprim(0, "poly");
pos = set(cut.x, min.y, max.z);
int npt = addpoint(0, pos);
addvertex(0, newprim, npt);
//创建对应的cut 点的线段

//-------------------------------------------------------------------------------------------



//--------------------------------------------------------------------------------------------
//计算一个悬挂物的曲线方程
//resample 中的curveu 属性，是从点的0点开始采样 一直到终点的一个0 - 1 的浮点值。从而记录每个线段的过度变化
// curveu 是基于面来计算的，每个面会认为成一个线段
@curveu = fit01(@curveu, -1, 1);//先把0 -1 的数值缩放到 -1 到 1 ；
float a = chf("a");
@P.y = a * cosh(@curveu / a);// 曲线函数
@P.y -= a * cosh( 1/ a);// 减去偏移值，保持整体起始点在中心点。

//--------------------------------------------------------------------------------------------




//--------------------------------------------------------------------------------------------
//创建像素的重新排列,按照亮度的平均值大小进行重新排序  avg() 求平均值，  argsort ()根据大小排序， pop() 返回被剔除的值
int npts[] = primpoint(0, @primnum);
int ids[];
float brights[];
vector cols[];
int started = 0;
float startval = chf("startval");
float endval = chf("endval");

foreach(int npt; npts){// 针对每个面进行所有点的收集
    vector ncol = point(0, "Cd", npt);//获取对应点上的色彩信息
    float brightness = avg(ncol);//求出平均值（即为亮度）

    if(started == 0 && brightness >= startval){//设置一个开关，started 先判断开关是否是0， 同时也要满足亮度大于设置的启动值
        started = 1;//打开开关
    }
    if(started){
        push(ids, npt);
        push(brights, brightness);
        push(cols, ncol);
        //如果开关打卡了，就把对应的点的数据push 到数组中
    }

    if(started == 1 && brightness <= endval){
        started = 0;//如果亮度信息达到了设置的结束值，才会运行下面的代码。 这里就是在满足这个条件之前，上面的代码会根据每个点进行执行
        int sorted[] = argsort(brightness); //首先求出brightness的大小顺序，argsort 为按照大小排序

        foreach(int id; ids){//在针对所有的获取到的id（点的列表）进行循环
            int sortid = pop(sorted); //把每个id数组对应的排序好的 sorted 数组剔除最后一位，反向排序。返回的值是被剔除的数组中的值
            vector col = pop(cols);
           // vector col = cols[sortid]; //新的col 则为被剔除的排序号的sortid 中的值
            setpointattrib(0, "Cd", id, col);
        }
    }
    resize(ids,0);
    resize(brights, 0);
    resize(cols, 0);
}

//-------------------------------------------------------------------------------------------------------







//-----------------------------------------------------------------------------------------------------------
//Intersecting_ Lines  创建一个相交后停止移动的点，然后在线段上创建新的点垂直于之前的线段继续生长

int npt = addpoint(0, v@P);// 首先创建一批点，在原有点的位置上
setpointgroup(0, "moving", npt, 1, "set");//把这些点放入到moving 的组中
addprim(0, "polyline", @ptnum, npt);//创建对应原始点，和新创建点的线




//针对moving 组的点进行下面的操作
if(inpointgroup(0, "moving", @ptnum)){
    vector dir = rand(@ptnum + 123) * {2, 2, 0} - {1, 1, 0};//rand()返回的值是0 -1 的， 通过 * 2 - 1 来拓展到 -1 到 1 这里是指方向向量从正到负的随机值
    v@dir = dir;//储存下来随机的方向向量
    v@startpos = v@P;// 储存下 初始的位置
    int prim[] = pointprims(0, @ptnum);//获得到当前点的所有的面的数组
    i@sourse = prim[0];//储存为第一个面为基础面

 }


if(inpointgroup(0, "moving", @ptnum){//先判断是否在moving 组中
    float amp = chf("amp");
    vector hitpos[];
    int hitprim[];
    vector hituv[];

    string grp = "!" + itoa(i@sourse); // 设置grp 为不在 sourse 的组中

    int intersects = intersect_all(0, grp, v@P, v@dir, hitpos, hitprim, hituv, 0.001, -1.0); //设置一个intersect_all 函数，通过返回所有ntersect 的值，返回的都是数组信息。0为没有hit

    if(intersects > 0){
        v@P = hitpos[0]; //如果有hit, 首先取到第一个碰撞的点的位置 ，设置为当前点的位置。
        @group_moving = 0;//移除moving 组，从而不在下一个tick 中执行相面的代码

        if(distance(v@P, v@startpos) > chf("min_length")){//设置一个长度最小值， 如果当前hit坐标 和起始坐标的距离大于最小值，则执行下面的
            float bias = nrandom(); //从 0- 1 随机取一个值
            vector newpos = lerp(v@P, v@startpos, bias); //在当前hit 坐标和 初始坐标中随机取一个坐标

            int npt1 = addpoint(0, newpos); //在这个随机都坐标上创建第一个点
            setpointgroup(0, "moving", npt1, 0, "set");//先关闭新创建的点的组

            vector ndir = normalize(cross(v@dir, {0, 0, 1})); //求的新的方向，通过和之前的方向向量进行cross
            if(nrandom() > 0.5)// 有一半的几率反向这个向量
                ndir *= -1;

            int nprims[] = pointprims(0, @ptnum);//找到当前点上的面信息。
            int nprim = nprims[0];//获取第一个面作为资源面

            int npt2 = addpoint(0, newpos);//在hit的位置创建第二个点
            setpointattrib(0, "dir", npt2, ndir, "set");
            setpointattrib(0, "startpos", npt2, newpos, "set");
            setpointattrib(0, "sourse", npt2, nprim, "set");//储存当前的面作为这个移动点的sorces
            setpointgroup(0, "moving", npt2, 1, "set");


            addprim(0, "polyline", npt1, npt2);


        }
    }
    else if ( distance(v@P, v@startpos) < chf("max_length")){
        v@P += v@dir * amp;

    }
    else{
        @group_moving = 0;
    }

}
//--------------------------------------------------------------------------------------------------------------------------



//-----------------------------------------------------------------------------------
//-----------------------------------------------------------------------------------
//-----------------------------------------------------------------------------------
//-----------------------------------------------------------------------------------

// Transoformation Matrix
// slerp lerp 2个 四元数
float bias = chf("bais");
vector axis1 = point(1, "P", 1);//获取两个线段的点作为中心向量
vector axis2 = point(2, "P", 1);

float angle1 = radians(chf("angle1"));//floa  需要转化为 radians ，因为 quaternion 需要 radians
float angle2 = radians(chf("angle2"));

vector4 qut1 = quaternion(angle1, axis1); //vector4 quaternion 来创建旋转变化
vector4  qut2 = quaternion(angle2, axis2);

vector rot = slerp(qut1, qut2, bias);//slerp 函数是两个quaternion 的混合，总会找到最近的方向

@P = qrotate(rot, v@P);//最终释放到@P 上需要 qrotate 函数。


//----------------------------------------------------------------------------------
//这段必须在detial下运行
matrix trn =ident();// 初始一个矩阵，函数使用 ident()

float angle_x = radians(chf("rotate_x"));//创建一个 float 转换成 radians
float angle_y = radians(chf("rotate_y"));
float angle_z = radians(chf("rotate_z"));

rotate(trn, angele_x, normalize({1, 0, 0})); //rotate 函数 对矩阵进行缩放和旋转
rotate(trn, angele_y, normalize({0, 1, 0}));
rotate(trn, angele_z, normalize({0, 0, 1}));

vector scale_v = chv("scalev");
scale(trn, scale_v);


vector translate_v = chv("translate");
translate(trn, translate_v);

4@trn = trn;
//-----------
//在point 上每个点都乘以这个矩阵
v@P *= trn;
//-------------------------------------------------------------------------------------------

//-------------------------------------------------------------------------------------
// eulertoquaternion 函数的使用 qrotate, qconvert ,

float anelg_x = radians(chf("x"));
float anelg_y = radians(chf("y"));
float anelg_z = radians(chf("z"));

vector eulvector  = set( angle_x, angle_y, angle_z);
vector4 qua = eulertoquaternion(eulvector, 0);
//创建欧拉角度的四元数，0 位顺序
matrix3 converM = qconvert(qua);//convert 四元数 为3x3的矩阵

matrix m = set(converM);//直接设置为4x4的矩阵

@P *= m;//矩阵需要乘法才能生效

//----------------------------------------------------

float anelg_x = radians(chf("x"));
float anelg_y = radians(chf("y"));
float anelg_z = radians(chf("z"));

vector eulvector  = set( angle_x, angle_y, angle_z);
vector4 qua = eulertoquaternion(eulvector, 0);
//也可以创建完欧拉角度的四元数直接作用于orient vector4上
@orient = qua;


//---------------------------------------------------------

float anelg_x = radians(chf("x"));
float anelg_y = radians(chf("y"));
float anelg_z = radians(chf("z"));

vector eulvector  = set( angle_x, angle_y, angle_z);
vector4 qua = eulertoquaternion(eulvector, 0);

v@N = qrotate(qua, v@N);
//也可以使用qrotate ，按照四元数旋转一个向量




//JoyVex 中的quaternion 函数理解
//--------------------------------------------------------------
//quaternion 的第一种函数类型  float angle, vector axis
float angle = chf('angle');
angle += @ptnum * ch('offset');
angle += @Time * ch('speed');
vector axis = normalize(chv('axis'));
@orient = quaternion(angle, axis);
//----------------------------
//quaternion 第二种方式 为 vector  方向 和 向量长度
vector axis;
axis = chv('axis');
axis = normalize(axis);
axis *= trunc(rand(@ptnum + @Time) * 4) * PI / 2;//这里主要是乘以向量的长度， 也可以按照x 34 ,y 20, z22 的度数来旋转
@orient = quaternion(axis);
@a = noise(@P + @Time);//创建一个noise 来影响axis的数值
@a = chramp('noise', @a);
axis *= trunc(@a * 4) * PI /2;
@P.y = @a;
@orient = quaternion(axis);
//--------------------------------------------------
//也可以基于当前的法线方向和up向量来定义一个quaternion
@N = {0, 1, 0};
float  s = sin(@Time);
float  c = cos(@Time);

@up = set(s, 0, c);
@orient = quaternion(maketransform(N, up));//这里使用maketransfor 来定义 z axis 和 y axis 的朝向。
//--------------------------------------------------
//使用欧拉角度来定义 四元数
vector rot = radians(chv("euler"));
@orient = eulertoquaternion(rot, 0);// 这里可以通过向量的值来确定在那个角度上旋转多少度，和上面的向量方向加长度是一样，
//后面的0 则是旋转的顺序，默认是 xyz
//---------------------------------------------------
//slerp quaternion 可以旋转两个qua 来获取平滑的过度
vector4 target, base;
vector axis;
float seed, blend;

axis = chv('axis');
axis = normalize(axis);
seed = noise(@P + @Time);
seed = chramp('noise', seed);
axis = trunc(seed * 4) * PI / 2;

target = quaternion(axis);
base = {0, 0, 0, 1};
blend = chramp('blend', @Time % 1);
@orient = slerp(base, target, blend);//slerp 是从一个qua lerp 到第二 qua 上，总是走最短的距离。
//--------------------------------------------------


//qmultiply 可以作用于两个qua 相乘， 可以获得两个角度上的变化。合并之后的效果，并且互不影响
vector N, up;
vector4 extrarot, talktalk, wobble;

N = normalize(@P);
up = {0, 1, 0};
@orient = quaternion(maketransform(N, up));
extrarot = quaternion(radians(90), {1, 0, 0});
talktalk = quaternion(radians(20) * sin(@Time * 3), {0, 1, 0});
wobble = quaternion({0, 1, 0} * curlnoise(@P + @Time ( 0.2)));

@orient = qmultiply(@orient, extrarot);
@orient = qmultiply(@orient, talktalk);
@orient = qmultiply(@orient, wobble);



//针对不是copy 的instance 模型下都transform 都需要使用到intrinsics 下的transform 属性
//可以通过提取模型的transfrom 数据，转化为 matrx  然后通过 rotate, transform， qconver 等函数来针对
//模型进行缩放和旋转的操作。 intrinsics 转化都都是matrx4 的数据所以需要转化为matrix3 来操作
matrix3 m = ident();
setprimintrinsic(0, "transfrom", @ptnum, m);
//---------------------------------------------------------
@orient = quaternion({0, 1, 0} * @Time);
v@scale = {1, 0.5, 1};

matrix3 m = ident();
scale(m, v@scale);
m *= qconvert(orient);//把一个四元数转化为一个 matrix3 的函数
//
rotate(m, angle, 1); //也可以通过rotate 函数来针对模型进行旋转
setprimintrinsic(0, "transform", @ptnum, m, "set");
//---------------------------------------------------------
//More on rotation Orient Quaternions Matricies Offset stuff
//---------------------------------------------------------
//---------------------------------------------------------
//一个matrix3 可以直接转化为 quaternion
matrix3 m = ident();
@orient = quaternion(m);

//也可以通过 angle 和 axis
float angle = @Time;
vector axis = rand(@ptnum);
@orient = quaternion(angle, axis);
//这里记住，在旋转中orient 的级别最高。

//random 的vector  是  0 -1 的 需要一个  - 1 到 1 的区间向量
vector axis = sample_direction_uniform(rand(@ptnum));
vector axis = sample_circle_edge_uniform(rand(@ptnum));
vector4 ori = sample_orientation_uniform(rand(@ptnum));
//可以直接返回对应的一个随机的方向


//如果想针对一个orient 旋转的偏移可以通过qrotate， 可以通过一个向量偏移，然后按照之前的orient旋转
vector pos = qrotate(@orient, {0, 1, 0});
@P += normalize(pos);

//或者通过qconvert 吧q 转化为 matrix3 然后乘以 向量，在更新到P上
vector pos = {0, 1, 0};
matrix m = qconver(@orient);
pos *= m;
@P += pos;
//--------------------------------------------------------------

//可以通过maketransform 来制定2个向量，第一个向量是 锁定轴向，第二个向量是旋转的轴向。
v@up = sample_direction_uniform(rand(@ptnum));
matrix3 m = maketransform(v@up, v@N);
@orient = quaternion(m);
//----------------------------------------------------------------


//----------------------------------------------------------------
//----------------------------------------------------------------

//primintrinsic  attrib “ transform”
matrix3 tn = primintrinsic(geometry, "transform", @ptnum)
//可以通过packinstance的模型上获取对应隐藏的属性叫， primintrinsic “transform”，这个属性是作用于在每个面上的
float anglex = radians(chf("x"));
vector eul = set( anglex, 0, 0);
vector4 qua = eulertoquaternion(eul, 0);
matrix3 mul = qconvert(qua);

matrix3 mulp = mul * tn;
//conver 四元数成为矩阵3x3 然后在作用于之前的矩阵上
setprimintrinsic(geohandle, "transform", @ptnum, mulp, mode="set");


//--------------------------------------------------------------------
matrix3 tn = primintrinsic(0, "transform", @ptnum);
float anglex = radians(chf("x"));

rotate(tn, anglex, {1, 0, 0});
//也可以通过rotate 函数来针对单一轴向上的旋转

setprimintrinsic(0, "transform", @ptnum, tn, "set");
//------------------------------------------------------------------
matrix3 m = ident();
float angle = @P.z * amp;
rotate(m, angle, {0, 0, 1});
//也可以通过创建一个空的3x3矩阵，来rotate旋转之后再设置为setprimintrinsic属性

setprimintrinsic(0, "transform", @ptnum, m, "set");

//-----------------------------------------------------------------------------------
//-----------------------------------------------------------------------------------
//抽取一个动画模型上的matrix
vector P1 = point(0, "P", 0);//从模型上寻找两个点
vector P2 = point(0, "P", 1);
vector upVector = set(0, 1, 0);

vector xAxis = normalize(P2 - P1);
vector zAxis = normalize(xAxis - upVector));
vector yAxis = normalize(zAxis, xAxis));

vector center = P1 - (P2 - P1) / 2; // 求两个点中间的坐标
matrix myTrans = set(xAxis, yAxis, zAxis, center);
setcomp(myTrans, 0, 0, 3);//清空矩阵最后的一列的数字为0
setcomp(myTrans, 0, 1, 3);
setcomp(myTrans, 0, 2, 3);

4@myTransform = myTrans;//储存matrix

//-------------------------------------------------------------------------
//local 轴向上的旋转 matrix

float angleX = chf("rot_x");
float angleY = chf("rot_y");
float angleZ = chf("rot_z");

float angleX = radians(angleX);
float angleY = radians(angleY);
float angleZ = radians(angleZ);

vector euler = set(angleX, angleY, angleZ);// 通过欧拉向量来制作四元数
vector4 quat = eulertoquaternion(euler, 0);//转化为四元数
matrix3 m3 = qconvert(quat);//通过qconvert 函数来把四元数转化为matrix3
matrix m = set(m3);//cast 成 matrx 4x4

if(hasdetailattrib(0, "xform")  {
    matrix inputXform = detail(0, "xform");
    @P *= invert(inputXform);
    m *= inputXform;

    }//如果detail  中已经含有了xform 的数值，先把定点乘以 invert的，在和m 继续想成
@P *= m;
setdetailattrib(0, "xform", m);



//在另一个WA translate in local space
float translateX = chf("translate_X");
float translateY = chf("translate_Y");
float translateZ = chf("translate_Z");

matrix m = inden();
translate(m, set(translateX, translateY, translateZ));//通过translate 函数来针对坐标进行变换

if(hasdetailattrib(0, "xform")  {
    matrix inputXform = detail(0, "xform");
    @P *= invert(inputXform);
    m *= inputXform;

    }
@P *= m;
setdetailattrib(0, "xform", m);
//---------------------------------------------------------------------------------
//---------------------------------------------------------------------------------
//---------------------------------------------------------------------------------
//求一个模型上的面的边和中心点，求得当前面的矩阵 模型上面的矩阵
int primNumber = 5; //按照模型的某一个面进行旋转或者位移变化
int edgeA = primhedge(0, primNumber);
int edgeB = hedge_next(0, edgeA);

int edgeA_P1 = hedge_srcpoint(0, edgeA);
int edgeA_P2 = hedge_dstpoint(0, edgeA);

int edgeB_P1 = hedge_srcpoint(0, edgeB);
int edgeB_P2 = hedge_dstpoint(0, edgeB);

vector A1 = point(0, "P", edgeA_P1);
vector A2 = point(0, "P", edgeA_P2);
vector B1 = point(0, "P", edgeB_P1);
vector B2 = point(0, "P", edgeB_P2);

vector X = normalize(A2 - A1);
vector tmp = normalize(B2 - B1);
vector Y = cross(X, tmp);
vector centor = getbbox_center(0);//中心点可以设置为模型的中心，也可以设置为面的中心坐标
//--------------------------------------------
vector centor = prim(0, "P", primNumber);
//-------------------------------------------
matrix m = set(X, Y, Z, center);
setcomp(m, 0, 0, 3);
setcomp(m, 0, 1, 3);
setcomp(m, 0, 2, 3);
4@xform = m;
//---------------------------------------------------------------------
//-----------------------------------------
//设置第二个box 然后input 0, 刚才的矩阵 input 1
@P *= matrix(detail(1, "xform"));







//-----------------------------------------------------------------------------------
//relpointbbox  JovVex
vector rel = relpointbbox(0, v@P);
@Cd = rel.y;
//可以获取到一个最小到最大的bbox的值坐标并且fit到0-1

//--------------------------------------------------------------------
// if statements
vector relbox = relpointbbox(0, v@P);
float angle = normalize(dot(v@N, {0, 1, 0});
if(abs(angle) < 0.3 && relbox.y > 0.4 && @ptnum % 4 == 0){
    @Cd = {1, 0, 0};
}
// ----------------------------------------------------------------------
// ---------------------------------------------------------------------

// nearpoints  function
int pts[] = nearpoints(1, v@P, maxdist, maxpts);

foreach(int pt; pts){
    vector pos = point(1, "P", pt);//获取到对应数组中的点的坐标信息
    d = distance2(v@P, pos);//求得邻点和当前自己之间的距离

    w = d * ch("freq");//先设置一个缩放值
    w -= @Time * ch("speed");//减去时间的变化值

    w = sin(w);//sin up
    w *= ch("amp");
    w *= fit(d, 0, ch("radius"), 1, 0);//fit 当前 距离 反向从 1 - 0， 即为距离中心点越近则为1. 越远越趋向于0
    @P.y += w;

}

//-------------------------------------------------------------------------

vector pos, col;
int pts[];
int pt;
float a, d, f, t;
float speed = chf("speed");
float amp = chf("amp");
float feq = chf("feq");
float radius = chf("radisu");
float colorFade;


pts = nearpoints(1, v@P, 20);
@Cd = 1;

foreach (pt; pts){
    /* code */
    pos = point(1, "P", pt);
    col = point(1, "Cd", pt);

    d = distance(v@P, pos);// 求出当前点和距离当前点最近的s点的距离
    d = fit(d, 0, radius, 1, 0);//反向这个距离，即为距离越远 值为0，越近则为1
    d = clamp(d, 0, 1);// 设置为 0-1 的区间
    t = @Time * speed;//设置时间变量
    t += rand(pt);//根据不同的点求一个随机值，偏移时间变量
    a = d * amp;
    f = d * feq;


    colorFade = distance(v@P, pos);//求出同样的距离
    colorFade = fit(colorFade, 0, radius, 0, 1);//设置为0 - 1 的区间
    colorFade = chramp("fade", colorFade);//使用ramp控制
    col = lerp(col, 1, colorFade);//通过lerp 来设置对应的色彩信息
    //这里通过距离0 -1 作为lerp 设置定点的色彩 距离越远越偏向1，越近则越偏向col
    //的颜色信息，这样可以达到远距离的位置进行lerp效果



    @Cd *= col;
    @P.y += sin(t + f)* a;
}

//------------------------------------------------------------------------
//-----------------------------------------------------------------------
//通过噪声来扰动生成的点
vector offset, pos;
int pr, pt;
float stepsize;
pr = addprim(0, "polyline");
stepsize = 0.1;

for(int i = 0; i < 10; i++){
    float inc = @ptnum * 0.1;// 根据当前点的index 来设置一个参数，随着点的不同而不同
    float x = cos(i * 0.6 + @Time + inc);// 通过cos函数来设置这个坐标的位置，inc 会随着点越高，大
    float y = sin(i * 0.6 + @Time + inc);

    offset  = set(x, 0, y) * 0.1 * i;//设置offse为sin 和cos 函数的值
    vector n  = curlnoise(@P * @Time + i) * 0.2;//设置一个 curlnoise 的函数通过i 作为递增关系
    n *= i * 0.1;//通过i循环来设置针对n的缩放
    offset += n;//吧两个向量运动作用到一起


    pos = (v@P + v@N * i * stepsize) + offset;//坐标为 当前左边 加上法线方向和步数，以及i的递增

    pt = addpoint(0, pos);
    addvertex(0, prim, pt);
}
//-----------------------------------------------------------------------------
//------------------------------------------------------------------------------
//通过distance 来驱动copy的的定点属性，法线方向 和up vector
float d, t;
float max = chf("max");
float min = chf("min");
t = @Time * chf("speed");
vector norl;

d = length(@P);
vector n = curlnoise(@P * chf("nfer") + t);
d *= ch("feq");
d += t;
d *= n.y;//设置噪声影响d 距离属性
d = fit(sin(d), -1, 1, min, max);//fit 距离sin -1 到1 到自定义的区间

@scale = set(min, d, max);// 设置pscale, 其中 copy to point 是锁定x轴向的

norl.x = cos(d);
norl.y = sin(d);
norl.z = 0;

@N = norl * chf("normarlpower");
d = fit(d, min, max, 0, 1);
@Cd = vector(chramp('color', d));
@P.y += sin(length(@P) + @Time) * 2) * 0.5;
v@up = set(sin(@Time + length(@P)), 0, cos((@Time + length(@P))));//设置一个up 向量，x 为sin, z 为 cos 则是让其旋转


//-------------------------------------------------------------------------------
//---------------------------------------------------------------------------------



//------------------------------------------------------------
//设置一个随机的点的组可以
setpointgroup(0, "food", @ptnum, 1);
//然后在设置随机的点的组

for(int i = 0; i  < 10; i++){
    int npt = int(rand(i) * @numpt);//使用rand 函数生成 0 -1 的数 在乘以最大的点数
    setpointgroup(0, "active", npt, 1, "set");
    setpointgroup(0, "food", npt, 0, "set");

}
//随机的选择一个数组中的点

if(@group_active == 1){
    int closepts[] = pgfind(0, "food", v@P, maxradius, maxpoints, maxradius);
    int numcpt = len(closepts);

    int dir = int(rand(@ptnum + 123) * numcpt);


    if(numcpt > 0){
        int ptid = closept(dir);
    }
}


//--------------------------------------------------
//--------------------------------------------------
//--------------------------------------------------
//minpos primuv xyzdist 最小距离， 面的uv, 这里的uv指的是每个面的 0 -1 的向量
//通过xyzdist 函数返回最近的点的距离，以及对应的属性，例如 primId,  Uv 等数据，然后
//在通过primuv 可以访问对应的面的属性，列入（ @P， @Cd, 等等.）
int primId;
vector uv;
float dist = xyzdist(1, v@P, primId, uv);
//然后在用储存的primid 和uv 信息 来获取到对应的数据
v@Cd = primuv(1, "Cd", primId, uv);
v@P = primuv(1, "P", primId, uv);
f@d = primuv(1, "d", primId, uv);
//parametric uvs
//scater 的output 中有一个sourceprimuv 属性， 可以直接显示看见parametric uvs
//这个uv 是针对每个面上的的vertex 点进行的一个bounding box 的大小的0 - 1 的缩放灰度图
//

//---------------------------------------------------------
//---------------------------------------------------------
//---------------------------------------------------------
//prim, vertexsplit, connectivity,
//facet 节点中的unique points 和 vertexsplit 一样，只是vertexsplit 需要根据uv 来进行拆分
//connectivity 则是可以根据一项属性来判断其中的连接性，可以创建一个对应的class 属性来归类，后续可以用到loop中
//add prim 严格需要point ,vertex 的顺序来创建面。
int pot[] = primpoints(geometry, primnum);//通过这个函数可以获得每个面所包含的点的id
i@sort = find(pot, @ptnum);//在通对比获得自己当前的点的id 是在那个面的id 上
i@primid = @primnum;//记录下面的id
//通过sort node 来对点进行排序，然后再创建新的面基于这些排序过的点
//创建面的中心点，可以通过
//frist promote the point pos to prim, then rename it attrib, and promote to point again, then:
vector scale = v@Pavg - @P;//通过promote的点的平均值获取到当前面的中心点的位置，然后在创建当前定点位置看向当前面的中心点的向量
@P += scale; //然后吧所有定点按照自己的计算的向量进行偏移



//-----------------------------------------------------------
//顶点动画在UE4中模拟飞鸟

vector grident = relpointbbox(geometry, v@P);//通过relpointbbox来创建一个0 -1 的bbox 大小的向量值
@Cd = 0;
@Cd = set(1- (clamp(grident.x, 0.5, 1)), 0, clamp(grident.x, 0, 1));//这里设置Cd的r，b 通道
//R 通道是设置为 最小值0.5， 到 1 的grident 数值，红色通道为最小值0.5， 蓝色则正常为 0 - 1 的衰减
//然后transform.scale = -1 -> reverse

##
vector grident = relpointbbox(0, v@P);
@Cd = 0;
@Cd.b = clamp(grident.x, 0, 1);
@Cd.r = clamp(grident.x, 0.5, 1);
//面片的另一边其实和这一边一样，
##
@Alpha = pow(distance(v@P, 0), 2) * 0.75;
//通过当前定点到中心点的距离求出一个渐变的过渡float， 然后在乘以 0.75；

//在houdini 中模拟
float myTime = @Time * 5 - @Alpha;  //设置为一个针对alpha渐变的时间过度差
float yMove = @Cd.b;//获取到蓝色通道的渐变值
float xMove = @Cd.r;

xMove -= 0.5;//xmove需要台上sin的正值
xMove *= 2;

xMove *= abs(sin(myTime)) * -1;//反向x轴的运动
yMove *= sin(myTime);

@P.x += xMove;
@P.y += yMove;
@P.y += cos(myTime) * chf("amp");
//------------------------------------------------------------------
//------------------------------------------------------------------


//rivet 是可以使用 xyzdist 先求出最近的面的坐标和uv之后通过primuv求得对应都pos 然后设置当前点的pos
//针对带有动画的模型文件，可以简单的通过
//先merge 来的模型取消transform 设置，然后xyzdist 来获取到对应的面id和 uv
int primId;
vector uv;
float dist = xyzdist(geometry, v@P, primId, uv);
i@primId = primId;
v@uv = uv;

//吧这些数据存贮下来之后，在通过merge 一个带有动画transform 的数据来抽取对应的prim 和 uv的pos
vector pos = primuv(1, "P", i@primId, v@uv);
v@P = pos;

//---------------------------------------------------------------------------

//同样的道理，如果使用sop则是需要通过sop : attribnterpolate 这个sop 来实现属性的变化。
//这里首先通过scatter一些点，然后打开scatter 中Output Attribute中的 PrimNumAttribute
//还有PrimUVWAttribute. 这样才可以使用 attribnterpolate sop

//-------------------------------------------------------------------------------
printf("%f", test);
//% 符合代表后面逗号之后的符号，f 则是数据类型"%i" 为int 类型 "%i\n"则是代表每行回车一次
//-------------------------------------------------------------------------------


//------------------------------------------------------------
smooth(value1, vaule2, amount);
//一个类似clamp的函数，可以更平滑的的把数据从0 - 1 进行缩放，特显是会提供一个easin/easeout
//的效果。
//------------------------------------------------------------

float r = chf("radius");
int nbrs[] = nearpoints(0,"infected",v@P, r);//在nearpt中搜索在infected 组中的点
int cnt = 0;//创建一个总数
float accum = 0;//先创建一个总和，

foreach(int nbr; nbrs){
    float dist = length(v@P - point(0, "P", nbr));//先求的当前点的位置和附近点直接的距离长度
    float infection = point(0, "infect"， nbr);//求得对应点上的infect 值
    float weight =  1 - smooth(0, r, dist);//通过smooth函数来平滑距离然后反向设置为权重。
    accum += infection * weight;//计算所有点的总和加在一起
    cnt++;//循环一次，增加一次count
}
f@infect += accum / float(cnt);//最后吧所有总和除以计数 求出平均值。
//------------------------------------------------------------
//-------------------------------------------------------------



//------------------------------ ------------------------------
//------------------------------ ------------------------------
//从贴图种获取色彩信息，可以使用的函数 colormap()
string file = chs("filepath");//首先先定义一个文件的路径，chs为string类型的数据
vector col = colormap(file, @uv);//这里点上首先必须有uv信息了，需要在之前创建好
vector hsv = rgbtohsv(col);
@Cd = hsv;
//-------------------------------------------------------------
//-------------------------------------------------------------


//------------------------------
//@数据类型 syntax houdini的所有内部变量名称
f@foo = 123.22;
i@foo = 4;
v@vector  = {0, 1, 0};
p@geoge;//quaternion, vector4
3@transform;//3 x 3  matrix


float

f@name

vector2 (2 floats)

u@name

vector (3 floats)

v@name

vector4 (4 floats)

p@name

int

i@name

matrix2 (2×2 floats)

2@name

matrix3 (3×3 floats)

3@name

matrix (4×4 floats)

4@name

string

s@name
//VEX type

//Attribute names

vector (3 floats)

@P, @accel, @center, @dPdx, @dPdy, @dPdz, @Cd, @N, @scale, @force, @rest, @torque, @up, @uv, @v

vector4 (4 floats)

@backtrack, @orient, @rot

int

@id, @ix, @iy, @iz, @nextid, @pstate, @resx, @resy, @resz, @ptnum, @vtxnum, @primnum, @numpt, @numvtx, @numprim, @group_*

string

@name, @instance

//-------------------------------------------------------
//---------------------------------------------------------


//------------------------------
//------------------------------
//通过每个点的坐标位置来针对sin cos 函数偏移的衰减效果
float d = length(@P);//通过获取到当前的点到所有的面的距离下，
float falloff = fit(d, chf("start"), chf("end"), 0, 1);//通过fit 函数来将要距离进行缩放到从start 到 end 的距离长度
v@P.y = sin(d * chf("scale") - (ch("speed") * @Time));//通过乘以一个数来模拟缩放，以及一个控制时间的数值相减
v@P.y *= ch("height");//最终来控制影响值
v@P.y *= chramp("falloff", falloff);//通过ramp 来控制距离的衰减效果

//-----------------------------------
//------------------------------
//极向量坐标
float angle = atan(@P.x, @P.y);// atan x, y 轴
float r = length(set(@P.x, @P.y));//只寻找有关x, y 轴向上的距离
float amount = radians(chf("amount"));//sin cos 需要的是radians 所以需要转
float twirl = chf("twirl");//

@P.x = sin(amount + angle + twirl) * r;// r 是每个点到这个旋转的距离，所以需要乘以这个距离衰减
@P.y = cos(amount +anlge + twirl) * r;//每个角度的旋转做一个偏移twirl 就可以产生不一样的效果
//-----------------------------------------------------
//------------------------------------------------------





//------------------------------
//------------------------------
//首先要创建一个带有uv的球体，并且设置为顶点的法线方向这里需要做的第一件事情是
//吧这个球体的所有的点投射到3d的uv空间中
int myvert = pointvertex(0, @ptnum);//先通过pointvertex函数来找到每个对应point的vertex index
int success = -1;//这里初始化下，-1 意味着没有成功。
vectpr puv = vertexattrib(0, "uv", myvert, success);//通过vertexattrib 函数来找到对应的位置信息。
v@P = set(puv.x, 0, puv.y);//这里获得的是对应uv坐标的位置信息，然后赋予给vP，只有uv中的向量方向和位置信息

//另一边需要创建对应的花纹图像，这里有一个很重要的点就是需要考虑到prim的关联性，然后记录对应的curveu
//信息的属性，以便后面进行重新排序和创建prim做基础
//缩放花纹到0 -1 的空间，以便后面和uv投射过的模型进行bool
vector min, max;
getbbox(0, min, max);
v@P.x = fit(v@P.x, min.x, max.x, 0, 1);//把自己的bbox 缩放到 0 -1 的区间之内
v@P.z = fit(v@P.z, min.z, max.z, 0, 1);
v@P.y *= 0.01;
v@N = {0, 1, 0};
//-
//然后分别和展开UV的模型挤出一点后进行bool运算，来获得interact 部分的geo。
//然后清除shared Edges 使用 divide sop ， 并且转化为open 的line 使用 ends 节点
//通过 connectivy 中创建class 数据，来保证，相连接的点获得一个class 名词
//然后删除所有的prim ，因为进行bool运算之后，原先的线段变成了面，现在需要清理掉多余的线段和面数
//删除掉之后， 通过获取之前的线段上的curveu 信息来重新order点的顺序。
int tarprim = -1;
vector taruv = {0, 0, 0};
 float dist = xyzdist(1,v@P, tarprim, taruv);//先获取到距离当前点最近的input1上的点（原先的线段的点）
 //从而获取到对应的prim id 以及prim uv 的坐标
 @curveu = primuv(1, "curveu"， tarprim, taruv);
//获取到正确的curveu信息之后就可以通过刚才创建的class属性进行循环，首先sort排序，然后创建prim
//创建完成之后，需要interact 到原先的uv展开的模型，获取到对应的uv信息和prim信息，在通过
//primuv 来获取到uv 展开之前的模型的pos 上，这样就完成了投射
vector orig = v@P + {0, 1, 0};
vector hitpos, hituv;
int hirprim = interact(1, orig, {0, -10, 0}, hitpos, hituv);//首先获取当前的点到投射的模型上的面
//来获取对应都prim 和 hit uv

if(hitprim > 0){
    vector pos = primuv(2, "P", hitprim, hituv);//获取到对应的prim 上的pos
    vector nnorm = primuv(2, "N", hitprim, hituv);//获取到对应的prim上的normal
    vector newn = v@P.y * tan;//当前y轴按照发现方向相乘。
    v@P = pos + newn;

}
else{
    removepoint(0, @ptnum);
}
//----------------------------------------------------------------------
//----------------------------------------------------------------------



//------------------------------
//------------------------------
int resx = chi("res_x");//先获得gird 的横向的res
float sizex = chf("size_x");//在获得对应的x的长度
float scale = sizex / float(resx);//平均每个点的大小的基础值为 长度/ 总的分段数
vector col = v@Cd;
float grey = avg(col);//这里通过avg 函数来求得一个向量的平均值。
f@pscale = (1 - grey) * scale * 0.5;//然后缩放是根据色彩的亮度的反向（1-）来计算的

//---------------------------------------------------------
//----------------------------------------------------------

//---------------------------------------------------------
//----------------------------------------------------------
//使用datatable 来导入数据，并生成图形的方法
//先使用ptyhon的 datatable导入数据，选择需要的数据的column以及数据类型等
vector sphereToCart(float lat, lon, rad){
    return rad * set(-cos(lat) * cos(lon),
                  sin(lat),
                  cos(lat) * sin(lon)
                  );
}
v@P = sphereToCart(
    radians(@lat),
    radians(@lon),
    1.0
);
v@N = normalize(v@P);
//通过这个函数来吧导入的地球数据正确都显示到houdini 中。
//这里需要在和导入的机场文件进行对比，通过属性查到来找到先关的数据，然后通过相关的数据的pos
//信息来在本体上创建对应的点的信息
int src = findattribval(1, "point", "id", i@src);
int dst = findattribval(1, "point", "id", i@dst);//首先通过findattrbval 来找到对应的数据

if(src >= 0 && dst >= 0){//如果找到的数据不为空
    int newprim = addprim(0, "polyline");//首先创建一个新的prim
    vector v1 = point(1, "P", src);//在找到的src的点上，找到对应的点的坐标
    vector v2 = point(1, "P", dst);
    int p1 = addpoint(0, v1);//在本体上创建改坐标上的点
    int p2 = addpoint(0, v2);
    float distance = distance(v1, v2);//测量起点与结束点的距离
    setpointattrib(0, "dist", p1, distance, "set");
    setpointattrib(0, "dist", p2, distance, "set");
    addvertex(0, newprim, p1);
    addvertex(0, newprim, p2);
}
//这里创建完成之后，先把多余的点删掉，即为blast new 以外的prim
//然后resample，并且打卡curveu 属性
//然后投射回所有点到球形上
v@P = normalize(v@P);
v@N = normalize(v@P);
//最后通过一个chramp 来驱动变形
float scale = chf("lift_scale");
float lift = chramp("lift_amount", @curveu);//这里通过curveu的属性进行chramp 可以控制一个曲线的弯度以及弯度的百分比
vector liftpos = v@P + (v@N * lift * scale * @dist);//新的距离则通过当前pos加上 法线方向上乘以缩放，乘以curveu，乘以距离而得
v@P = liftpos;
//---------------------------------------------------------------------
//---------------------------------------------------------------------
//---------------------------------------------------------------------





//---------------------------------------------------------------------
//---------------------------------------------------------------------
//vex 使用的心得
// 1. 当前点上的attribs 控制当前点上的其他attribs (@Cd = @P)
// 2. 当前点上的attribs通过函数来控制当前点上的其他attribs(@Cd = noise(@P))
// 3. 别的点上的attribs 来控制当前点上的attrbi(@Cd = point(0, "P", 4))
// 4. 其他点上的attribs通过函数来控制当前点上的attribs(@Cd = noise(point(1, "P", 4)))
// 5. 访问当前模型上的列表(nearpoints)或者属性列表(findattribval),然后在反过来看列表中都这些点的属性
// 6. 通过点云来访问任何模型上的点的所有信息
// 7. 可以在进入wrangle之前就准备好数据的平均值之类的操作
// 8. 如果需要从其他的物体上获取到attribs，可以通过相同的模型上获取不同的属性
// 9. 经常会从别的点上来设置当前点上的属性。比如设置别的点上的属性基于当前模型上的点的属性
// 10. 通常可以把很多操作规划为两部分，第一部分为创建，读取属性。 第二个则是实际的操作和计算
// 11. 可以把一些属性放置如detial模式下，然后通过forloop 来访问，这样更安全。
//---------------------------------------------------------------------
//---------------------------------------------------------------------

//blur的vex，一个gird 上有50个分段，通过以下几种方法可以针对Cd属性进行模糊操作，
//模糊的操作算法就是计算当前点周边的一定范围内的所有都点，然后吧所有的属性的总和除以个数，求得平均值，然后把当前的点设置为平均值

//第一个方法，直接计算当前点的所有的周边的值，然后相加除以个数
int widht =50;
vector left = point(0, "Cd", @ptnum -1);
vector right = point(0, "Cd", @ptnum + 1);
vector top = point(0, "Cd", @ptnum + 50);
vector bottom = point(0, "Cd", @ptnum - 50);
@Cd = left + right + top + bottom;
@Cd /= 4;

//----------------------------------------------------------------------------
//----------------------------------------------------------------------------
//通过访问neighbourcount 进行的循环
int npt = neighbourcount(0, @ptnum);//通过这个函数可以访问到每个点相连接的点的个数
vector totalCd = 0;
for(int i = 0; i < npt; i++){//通过这个总数进行循环，针对每个相邻的点
    int nptnum = neighbours(0, @ptnum, i);//通过neighbours可以访问对应的相邻的点的index 返回
    totoalCd += point(0, "Cd", nptnum);//吧所有的相邻的点的cd属性相加起来
}
@Cd = totalCd / npt;
//--------------------------------------------------------------------------
//通过neripoints 数组访问
int npts[] = nearpoints(0, v@P, 1, 8);
vector totalCd = 0;
foreach(int npt; npts){
    totalCd += point(0, "Cd", npt);
}
@Cd = totalCd / len(npts);
//---------------------------------------------------------------------------
//---------------------------------------------------------------------------
//使用pcopen ，pcfilter 直接获取到差值
int  handle = pcopen(0, "P", vP, 1, 9);
@Cd = pcfilter(handle, "Cd");
//----------------------------------------------------------------------------
//------------------------------------------------------------------------------
int npt = neighbourcount(0, @ptnum);
int arrptp[] = {};
for(int i =0; i < npt; i ++){
    int np = neighbour(0, @ptnum, i);//这里通过index 访问到所有的相邻的点的index 通过这就
    //可以通过point（）函数来访问对应的点的attribs
    append(arrpt, np);
}
//--------------------------------------------------------------------------
//--------------------------------------------------------------------------
//树木的生长算法，计算一群point，一部分设置为attractors组，另一部分少量的，生长的起点设置为nodes组
//然后进入solver
//首先在attractors组中寻找周边范围内的点，并且吧这些点放到一个数数组中
i[]@associates = array();//针对每个attractors组的点创建一个空的数组
float infrad = chf("infrad");
int nearpt = nearpoint(1, "nodes", v@P, infrad);//在每个a组中的点寻找对应在n组中在范围的点。
int valarr[] = array(@ptnum);//创建一个当前点的id的数组
setpointattrib(0, "associates", nearpt, valarr, "append");//然后吧所有找到对应的A组的点放到N组的点上
//在A组中寻找附近范围内N组的点，然后吧A组的这些点的Id放到N组中的数组去
//然后在到N组中执行
float rad = chf("rad");
int myassociates[] = i[]@associates;//先把之前在N组上找到最近的A组都点招进来
if(len(myassociates) > 0){//针对这些A点进行下面的操作
    vector sum = 0;
    foreach(int node; myassociates){
        vector pos = point(0, "P", node);
        vector dir = normalize(pos - v@P);
        sum += dir;//计算所有A组点到当前N组点的向量总和
    }
    sum = normalize(sum);//然后规格化这些向量
    int nnode = addpoint(0, v@P + (sum * rad));//在种这些点上的平均值 乘以生成的最小单位的pos 上创建新的点
    setpointgroup(0, "node", nnode, 1, "set");//吧新创建的点设置为n组
    setpointgroup(0, "Cd", nnode, {1,0,0}, "set");
    int prim = addprim(0, "polyline");
    addvertex(0, prim, @ptnum);
    addvertex(0, prim, nnode);
    //连接新创建的点和当前点的线段

}
//这里创建完成后，需要一个killrad来防止不断在自身上创建，移除掉已经创建过的点
//下面在N组中执行
float killrad = chf("killrad");
int nearpt[] = nearpoints(0, "attractors", v@P, killrad);//再次在N组的附近寻找A组的点，
foreach(int pt; nearpt){
    removepoint(0, pt);
}//只要是在kill半径内的A组的点都删除掉
//1 首先在A组中找到距离最近的N组的点，然后把自己的ID输入到N组这些点上的数组中。
//2 然后在在N组中针对这些A组的点，求得方向向量的平均值，然后乘以生长的最小单位，获得新的点，在这些点
//上创建新的点，并且设置心创建的点组为 N组，创建线段等。
//3 在N组中看在kill半径中的A组的点，如果有的话就全都删除掉。
//--------------------------------------------------------------------------
//--------------------------------------------------------------------------



//--------------------------------------------------------------------------
//--------------------------------------------------------------------------
//像素画图形的算法
//通过一个grid 获取一个attribfrommap，可以通过chramp针对图形的cd进行反向，或者取色
//先通过foreachloop ，首先确保输入的所有的面都不在group_do 中
//然后input 0 为foreach input1 为attribformp ， Run Over Prim
vector size = getbbox_size(0);
float serachrad = size.x * 0.5;
int pt = nearpoint(1, v@P, searchrad);

if(pt> -1){
    @group_do = 1;
}
//这里是通过首先寻找bbox的一半的范围内的nearpoint，对比的点是输入1 和当前自身点的坐标
//即为查看当前的面上是否有输入1的点存在，如果存在，则吧当前prim放入到group_do 中
//然后通过subdivide来细分prim，但是只在do组中执行。
//把整体的foreachloop 放到一个loop中，循环几次就可以了
//-----------------------------------------------------------
//另一个类似的算法，则是首先吧input1的prim的Cd属性设置为-1
//然后是下面的代码 RunOver Prim
float threshold = pow(chf("color_thres"), 2);//这里使用的是distance2能耗更小一些
vector size = getbbox_size(0);
float searchrad = size.x * 0.5;
int pts[] = nearpoints(1, v@P, searchrad, 10000);//在input1种找到所有的每个点附近的点
int ctrpt = pts[0];//距离最近的面的点就是数组中第一个点
vector ctrcol = point(1, "Cd", ctrpt);//获取到最近的面的色彩信息
vector avgcol = {0, 0, 0};
float n = 0;
foreach(int pt; pts){
    vector col = point(1, "Cd", pt);
    avgcol += col;
    n++;
}//然后吧这些所有的距离的面的色彩信息加在一起，求平均值
avgcol /= n;
if(distance2(v@Cd, avgcol) > threshold){
    @group_do = 1;
    v@Cd = avgcol;
}//最后通过判断，当前cd的值和平均cd的值的距离的平方 是否大于一个thres， 如果是的话，则放入do组中
//--------------------------------------------------------------------------
//--------------------------------------------------------------------------




//--------------------------------------------------------------------------
//--------------------------------------------------------------------------
//合并之后的组都会拥有一个groups隐藏在detial中，这里可以通过detailintrinsic()函数来获得一个string
//的group的数组，在通过expandprimgroup 可以获得改组的所有的点，面，之类的信息
//可以按照规矩吧面或者点放到一个特定的组中partition sop 可以根据attrib 来定义组
string groups[] = detailintrinsic(0, 'primitivegroups');//通过detail函数来获得对应的group数组
int rand = int(rand(@Frame) * len(groups));//通过rand 来得到0 - groups 最大的数值
int prims[] = expandprimgroup(0, groups[rand]);//这个可以获得对应数组id的所有的prim id
foreach(int p; prims){
    removeprim(0, p, 1);
}
//----------------------------------------------------------------------------
//针对每一个球体分别给一个不同的组，然后通过下面的代码
string groups[] = detailintrinsic(0, 'primitivegroups');
foreach(string g; group){
    if(inprimgroup(0, g, @primnum) == 1){
        @Cd = rand(random_shash(g));
    }
}
//-------------------------------------------------------------------------------





//-------------------------------------------------------------------------------
//-------------------------------------------------------------------------------
//首先随机给一些面特定的黑色，其余为白色，然后在solver 中执行下面的代码
//类似于random worlker 的算法，
//如果有1个active 邻居， 那么自己激活，邻居死亡
//如果有2个active 邻居，那么我死亡，邻居激活
//如果有4个active邻居，那么我死亡
int left = prim(0, "Cd", @primnum -1);
int right = prim(0, "Cd"， @primnum + 1);
int top = prim(0, "Cd", @primnum + 30);
int bottom = prim(0, "Cd", @primnum - 30);

int total = left + right + top + bottom;

if(total == 1 && @Cd ==1){
    @Cd = 0;
}
if(total == 2 && @Cd == 0){
    @Cd = 1;
}
if(total == 4){
    @Cd = 0;
}
//---------------------------------------------------------------------------------
//-------------------------------------------------------------------------------


//---------------------------------------------------------------------------------
//-------------------------------------------------------------------------------
//按照curl 噪声生长的动画
//首先在一个grid 上扫描很多的点，然后随机选择2个点设置为active组为1.其余的active 为0
//然后创建一个curl noise 的法线效果
//然后在solver 中执行，
if(@active == 0){//先判断是否在active为0 需要在这里面执行
    float maxidst = chf("max");
    int maxpt = 5;
    int pts[] = nearpoints(0, v@P, maxdist, maxpt);//找到当前点的邻居
    float tactive, dot;
    vector aimpos;
    foreach(int pt; pts){
        tactive = point(0, "active", pt);//先获得邻居点的active属性
        aim = v@P - point(0, "p", pt);//获得当前点到邻居点的向量
        dot = dot(aim, v@N);//对比这个向量和当前N的夹角
        if(tactive == 1 && dot >= 0){//如果邻居的点首先是active组的，同时和当前的法线夹角位于同一方向
            @active = 1; //先设置active 属性为激活
            int prim = addprim(0, "polyline");
            setprimgroup(0, "new", prim, 1, "set");
            addvertex(0, prim, @ptnum);
            addvertex(0, prim, pt);
            @age  = @Frame;//吧当前的帧数输入到age属性中，这样先创建的age就小，后创建的就大
            return;
        }
    }
}


//---------------------------------------------------------------------------------
//-------------------------------------------------------------------------------
//制作Quilling，首先通过一个图片处理为只显示外轮廓的黑白边缘，scatter cd之后通过fracture可以生成一个根据
//扫描点区分的模型块，在通过原始的cd 转化到prim 上进行着色
//delete 白色区域为
(@Cd.r + @Cd.g + @Cd.b)/3 > 0.9
//求出平均值之后看看是否大于0.9
//或者通过prim wrangle
float acol = avg(@Cd);
if(acol > 0.9){
       removeprim(0, @primnum, 1);
}
//resample 之后 smooth点
//获取中心pos 的左边
v@ctr = v@P;//运行在Prim下
//通过primitive sop 吧prim 打开 同ends sop 一样
//找到每个面的每个点到中心点的最小距离
int npts[] = primpoints(0, @primnum);//先获取到每个prim 下的所有点
int numpts = len(npts);//以及对应的点的个数

float mindist = 1000000;//先预设一个最小距离
foreach(int npt; npts){//针对所有的点进行循环
    vector npos = point(0, "P", npt);//获取到每个面的点的pos
    float dist = distance(v@P, npos);//测量相关点到面的中心店的距离
    if(dist < mindist){//如果当前距离小于mindist 就吧mindist 设置为对应的距离长度
        mindist = dist;
    }

}
f@dist = mindist;
i@numpts = numpts;
//这里用比较的方法找最小，可以进行递归到每个点，因为是针对每个prim上的所有点进行循环，找到每个prim 下距离中心点最近的点
//并且吧这些点返回到每个prim属性中
//然后吧dist 转化到点中
//然后创建卷形的面，在prim 下运行
float width  = chf("paper_thickness");

int npts[] = primpoints(0, @primnum);
int numpts = len(npts);
int maxnum = int(f@dist / width);//最大的循环次数为，距离 除以 宽度。求出可以循环的次数
int newprim = addprim(0, "polyline");
setprimattrib(0, "Cd", newprim, v@Cd, "set");
float n = 0;
for(int i = 0; i < maxnum; i++){//在循环maxnum次下
    foreach(int npt; npts){//针对每个面的所有点进行下面的循环
        float offsetamp = n / (maxnum * numpts);//线求出偏移的强度，使用N 除以 最大的循环次数，乘以点的个数。即为从0 - 1 的强度值，根据循环逐渐增加
        vector npos = point(0, "P", npt);//找到每个点的pos
        vector offset = v@ctr - npos;//求出每个点到中心点的方向向量
        npos += offsetamp * offset;//新的点的坐标为方向 * 强度
        int newpt = addpoint(0, npos);//在这个pos上创建新的点
        addvertex(0, newprim, newpt);//吧这个点加入到prim 中
        n ++;
    }
}
removeprim(0, @primnum, 1);//删除所有的面
//在做一个resmaple 然后开启curveu 属性
//这里创建 一个随机的 zscale属性
//通过zscale 来获得polyextrude 挤出 的随机值
//创建对应的connectivity class 每个连接的模型
//对应制作random y 轴向上的偏移
if(@P.y > 0.00001){
    vector pos = v@P;
    v@P = set(pos.x, pos.y + chramp("y_ramp, f@curveu") *chf("y_amp") + (noise(f@curveu * 8 + @class * 18) * 0.05 - 0.025), pos.z);
}

//-----------------------------------------------------------------------------
//-----------------------------------------------------------------------------
//dihedral 函数，获得一个而面体，diheral(a, b)会按照b的轴向进行锁定。
vector dir = sample_direction_uniform(rand(@ptnum));//创建一个随机的向量方向
matrix3 m = dihedral(dir, v@N);// 按照随机的轴向方向， vN 为锁定的轴向，即按照N的向量方向旋转
rotate(m, @Time + rand(@ptnum), @N);//旋转这个向量
@orient = quaternion(m);//作用回Orient

//-----------------------------------------------------------------------------
//-----------------------------------------------------------------------------
//如果想在保持原有的orient基础上进行局部的旋转偏移
vector4 pitch = quaternion({1, 0, 0} * ch("pitch"));
vector4 yaw = quaternion({0, 1, 0} * ch("yaw"));
vector4 roll = quaternion({0, 0, 1} * ch("roll"));

@orient = qmultiply(@orient, pitch);
@orient = qmultiply(@orient, yaw);
@orient = qmultiply(@orient, roll);

//另一个案例，根据qmultiply 来执行
//-----------------------------------------------
float speed = rand(@ptnum, 123) * @Time;
float offset = rand(@ptnum, 445);
float flap = sin(speed + offset);
vector4 pitch = quaternion({1, 0, 0} * flap);
@orient = qmultiply(@orient, pitch);

//----------------------------------------------------
//----------------------------------------------------
//判断点的法线方向是否为绝对的垂直轴向
if(max(abs(normalize(@N))) !=1){
    removepoint(0, @ptnum);
}
//max()输入一个向量，返回的是最大的值， abs 则为正数，normalize()则是单位向量话。 一个｛1， 0， 0｝normalize之后不变
//一个 ｛1， 1，0｝normalize 之后则为 ｛0.75， 0.75， 0｝

//----------------------------------------------------
//----------------------------------------------------
//如果缩放一个poly
matrix3 m = ident();
scale(m, chv("scale"));
@P *= m;
//如果缩放一个prim
matrix3 m = ident();
scale(m, chv("scale"));
setprimintrinsic(0, "transform", 0, m);
//prim 则需要通过访问隐藏的primtransform属性来实现
//----------------------------------------------------
//----------------------------------------------------

//----------------------------------------------------
//----------------------------------------------------
//可以根据另一个物体的坐标位置来旋转自己，垂直与他的法线
vector aim;
vector4 q;
aim = chv("aim");//link 到另一个武器的pos上
@N = sample_circle_edge_uniform(rand(@ptnum));//创建一个按照圆形的法线方向
q = dihedral({0, 0, 1}, aim);//按照aim的方向进行旋转
@N = qrotate(q,v@N);//使用这个q来旋转法线
@N *= ch("scale");


//----------------------------------------------------
//----------------------------------------------------
//求得面的向量方向可以先通过法线方向和世界坐标的Y轴进行cross ，求出来的向量在和法线方向cross
vector up = {0, 1, 0};
vector temp = cross(v@N, up);
vector sur = cross(temp, v@N);
float sp = (fit(f@pscale, 0.005, 0.04, 0.1, 1) * chf("amount"));
@P += sur * sp;
//这里是把两个同样的球体，按照模型的表面法线方向进行偏移之后，在重新merge 起来

//雪花的计算算法
//----------------------------------------------------
//----------------------------------------------------
//----------------------------------------------------
//----------------------------------------------------
//先通过pointfrovalume sop 获得一系列的点。
//首先通过connectadjacentpieces sop 来进行连接，neighbours 获取到对应的每个邻居的点储存起来
//删除连接的面
//初始化val数值以及组
@val = chf("beta");
@group_ice = 0;
@group_boundary = 0;
//将初始化的val数值进行随机范围控制
@val += fit(nrandom(), 0, 1, -1 * chf("random"), chf("random"));
//随机选择一个seed 座位初始的位置
int numnit = chi("number_init_points");//选择初始化的点的个数
vector nullpos = {0, 0, 0};
int closept[] = nearpoints(0, nullpos, 10000.0, numinit);//在坐标为000的位置选择一个附近的点，这个点作为初始的点
foreach(int pt; closept){
    setpointattrib(0, "val", pt, 1.0, "set");//将这个点的组设置为ice, val 数值为1
    setpointgroup(0, "ice", pt, 1, "set");
}
//初始化boundary
int closept[] = i[]@neighs;//每个点都根据之前储存的相邻的点进行循环
foreach(int pt; closept){
    if(inpointgroup(0, "ice", pt)== 0){//判断相邻的点是否有在ice组中中的
        setpointgroup(0, "boundary", pt, 1, "set");//如果有的话，就把这些相邻的点放入到 boundary组中
    }
}
//然后进入solver
//这里需要区分为2部分 第一部分
//先针对ice 和 boundary 组中的点进行
@val = 0.0;
//然后针对所有的点进行操作
float alpha = chf("alpha");//创建一个alpha
float weight = alpha / 12.0;//权重
int closept[] = i[]@neighs;//选择所有的邻居的点
@val *= 1.0 - weight * 0.6;//当前点的val 为这样计算
foreach(int pt; closept){
    @val += point(0, "val", pt) * weight;//邻居的点这样计算
}


//第二部分
//对ice 和 boundary 组中的所有点
@val += chf("gama");
//然后针对不是在 ice 和 不是在 boundary 组中的点操作
@val = 0;
//然后在吧第一部分和第二部分组合起来
@val += point(1, "va;", @ptnum);
//根据val的数值来更新组中点
if(@val >= 1.0){
    @group_ice = 1;
    @group_boundary = 0;
}
//所有点中的val数值一旦大于1 就放到ice 组中
//针对ice组中的内容
int closept[] = i[]neighs;//继续查询相邻的点
foreach(int pt; closept){
    if(inpointgroup(0, "ice", pt)==0){//如果相邻的点中 有在ice 中的话，就放入到boundary 组中
        setpointgroup(0, "boundary", pt, 1, "set");
    }
}




//----------------------------------------------------
//----------------------------------------------------
//sign 根据输入的数值的正负或为0，则返回一个int的 数， -1 ， 0， 1
//floor 返回最大的整数值
//魔方算法
float t = floor(@Time * chf("speed")) + chramp("time", @Time%1);//按照时间来计算刷新的速率
int randaxis = int(rand(floor(t),123) * 3);//创建一个随机的int值 从 0 - 2；
int randslice = int(rand(floor(t),345)* 3);
float randdir = sign(fit(rand(floor(t), 919),0,1,-1,1));//通过floor t 来获取到较大的int 数值，然后
//通过rand函数返回一个 0 -1 的数值，然后通过 fit 缩放到  -1 到 1的float ， 在通过sign 来返回 -1 1 的int

vector axis = {0, 0, 0};
if(randaxis == 0) axis = {1, 0, 0};
if(randaxis == 1) axis = {0, 1, 0};
if(randaxis == 2) axis = {0, 0, 1};

float slice = 0;
if(randslice == 0) slice = -0.5;
if(randslice == 1) slice = 0;
if(randslice == 2) slice = 0.5;
//根据每次随机的值，来确定使用哪个轴向，和切线在那个方位， 因为box 是1的一个单位的，所以可以看做为-0.5, 0.5 0 的坐标
matrix3 m = ident();
float angle = randdir * $PI / 2 * t;//旋转的角度等于 randdir 位 -1 到 1  正向，或者反向， PI / 2 * t;
rotate(m, angle, axis);
if(sum(@P * axis)== slice){ //判断当前P坐标和 随机的轴向的总和， 是否和 slice 相互匹配
    @P *= m;
    @orient = quaternion(m);
}
//---------------------------------------------------------------------
//---------------------------------------------------------------------
//---------------------------------------------------------------------
//---------------------------------------------------------------------
//可以吧.h文件当道D:\Backup\Documents\houdini18.0\vex\include 目录下，就可以通过
#include "sdsdf.h" //来引入函数 vex incloude



//---------------------------------------------------------------------
//---------------------------------------------------------------------
//创建一个spherical  linear gradient
//spherical  只需要判断两个点直接的距离，然后判断所有点到p1点的距离 用两点之间的距离减去
vector p1 = point(1, "P", 0);
vector p2 = point(2, "P", 0);

float r = distance(p1, p2);
@Cd = r - distance(v@P, p1);
//linear 算法一
//首先 创建一个x轴， 目标的旋转是围绕着 p2 -p1 这个向量的， 首先@Cd 是所有点到p1的方向向量。
//然后创建一个四元数，轴向是x轴，旋转的向量是 p2 - p1 的向量。
//按照这个四元数进行旋转当前的Cd 即为 所有点到p1的向量
//然后当前的Cd的x轴向平均下  p1 到 p2 之间的距离
vector p1 = point(1, "P", 0);
vector p2 = point(2, "P", 0);

vector xaxis = {1, 0, 0};//首先创建一个x轴作为基础轴向
vector aim = normalize(p2 - p1);//选择两个点之间的向量作为旋转
float d = distance(p1, p2);
@Cd = @P - p1;//当前cd 为 所有点到 p1点的向量

vector4 q = dihedral(aim, xaxis);//创建一个四元数，按照x轴向旋转，看齐 aim 向量
@Cd = qrotate(q, @Cd);//通过这个四元数旋转当前的cd 向量
@Cd = @Cd.x / d; // 获取到x轴向上的平均值。

//linear 算法 二
//通过p1 到 p2 的方向向量，和 所有点到p1点的方向向量 的dot 值， 然后除以 p1 到 p2 点的距离
vector p1 = point(1, "P", 0);
vector p2 = point(2, "P", 0);

vector v1 = @P - p1;//v1 是所有点到p1点的向量
vector v2 = normlaize(p2 - p1);//v2 则是两点之间的向量
float r =  distance(p1, p2);//求出两点之间的距离
@Cd = dot(v1, v2) / r;
//---------------------------------------------------------------------
//---------------------------------------------------------------------


//---------------------------------------------------------------------
//---------------------------------------------------------------------
//通过polyframe 获取到的向量进行偏移 制作 spirals //按照tangent 方向旋转法线  通过缩放curveu 来获取到缩放
//可以通过resmaple 获取到curveu 属性然后获取到 normal, tangent , bitangent 等向量。然后
float speed, angle, rand;
vector dir;
vector4 q;
dir = @N;//首先方向是按照当前的n方向的
speed = @Time * chf("speed");
angle = speed + @curveu * chf("spirals"); //角度等于 @curveu 属性 + 速度的旋转 意味着 线段的不同位置下收到的旋转的值不同，从 0 -1
q = quaternion(v@t * angle);//按照tangent 方向进行旋转的四元数
dir = qrotate(q, dir);//通过这个四元数旋转法线的方向
rand = 1 + rand(@ptnum) * chf("random_offset");//做一个随机的值 至少从1 开始 1 +
@P += dir * chf("offset") * rand; //当前左边加上旋转后的dir 在加上偏移
//---------------------------------------------------------------------
//---------------------------------------------------------------------


//---------------------------------------------------------------------
//---------------------------------------------------------------------
//制作一个拼图动画效果
//总体思路是将一个gird ，存储所有的unique points之后，通过assemble 来获取到每个面的中心点，然后通过这些点。
//记录一个rest 的位置信息，然后随机寻找邻面的点，通过访问对方的rest 坐标然后把自己lerp 到对方的坐标上
//邻面则也会按照这样的做法反之。
//grid - uvquickshade -  facet - assemble - rest -
//针对0点
int pts[] = nearpoints(0, @P, 1);//先寻找临近的1单位的范围的点
pop(pts, 0);//首先剔除掉自己
i[]@a = pts;//把这些点存起来
i@pt = pts[int(rand(floor(@Time))*2)];//在一个数组中随机选择元素
v@pos = point(0, "rest", i@pt);//吧随机选择到的点的''rest'坐标记录为 pos

//然后进入solver 中模拟
float t = @Time * chf("speed");
if(t%1 == 0){//首先判断当时间为正一秒的时候，进行重置 rest 和 pos
    @rest = set(rint(@p.x), rint(@P.y), rint(@P.z));//先把rest 坐标按照当前的坐标取整数
    @P = @rest;//把取整数的rest 设置为pos
    int pts[] = nearpoints(0, v@P, 1, 3);//在附近寻找 3个点
    pop(pts, 0);//去除掉自己
    i[]@a = pts;//存储起来
    i@pt = pts[int(rand(floor(t))*2)];//随机选择一个临点
    v@pos = point(0, "rest", i@pt);//获得到他的rest 位置
}
else{
    if(@ptnum == 0 && distance(@pos, @rest) > 0){//当不为整数的时候， 如果 当前点为0 号， 并且pos 目标移动的位置到 rest 自己当前的位置的距离大于0
        setpointattrib(0, "P", 0, lerp(@rest, v@pos, frac(t)), "set");//通过设置点的p 然后按照lerp函数设置过去
        setpointattrib(0, "P", i@pt, lerp(v@pos, v@rest, frac(t)), "set");//而邻点则反之
    }
}

//---------------------------------------------------------------------
//---------------------------------------------------------------------



//---------------------------------------------------------------------
//---------------------------------------------------------------------
//制作一个Dynamic Weave 使用pop grains
//创建两条垂直的线段，一条复制到另一条上，另一条需要增加一些随机点，则需要创建一个 curveu 属性 ，然后通过这个属性进行排序
//这里创建的curveu 可以直接使用
@curveu = float(@ptnum);
//经过scatter 之后这个值会被平均分配到所有的点上。
//然后储存下当前所有点的prim数，因为创建出来的线段，所以每条线段目前是一个prim
//通过group expression 来找到第一行的seed 组的点
@myprim == 0 && rand(@ptnum)< 0.5//prim 为0 并且随机的点小于0.5
//然后converline ，拆分每个线段为一个prim
//储存下rest 的坐标
//初始化 pbd  这里需要设置 mass  和 @pscale 属性
//pop net 里的力的设置主要是通过 popforce 然后key 影响的动画，然后在通过 rest - v@P 作为 targetforce
//来行程两种力 互相牵制
//这里着重记录 connect 的算法
//首先是针对在seeds 组中的点进行的计算
float searchrad = ch("searchrad");//先选择一个搜索的半径
int nearpts[] = nearpoints(0, @P, searchrad);//通过每个点的坐标进行搜索
foreach(int pnt; nearpts){
    int tarmyprim = point(0, "myprim", pnt);//先找到对应点的myprim 数据
    if(tarmyprim == @myprim + 1){//只有在找到的prim 是 我当前点的prim + 1 的情况下，这意味着只寻找附近的prim
        int nprim = addprim(0, "polyline");//创建新的prim
        addvertex(0, nprim, @ptnum);
        addvertex(0, nprim, pnt);

        setpointgroup(0, "seeds", @ptnum, 0, "set");
        setpointgroup(0, "seeds", pnt, 1, "set");
        vector tarpos = point(0, "P", pnt);//找到匹配的点的位置
        float dist = length(@P - tarpos);//求出两个点的距离长度
        setprimattrib(0, "restlength", nprim, dist * 0.5,"set");//设置当前prim 的restlength 为新的距离的一半
        break;//这里只要找到一个符合要求的就break 出去
    }

}



{% endhighlight %}