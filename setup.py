from setuptools import setup


def read_requirements():
    with open('requirements.txt') as req:
        return req.read().splitlines()


with open('README.md', 'r', encoding='utf-8') as fh:
    long_description = fh.read()


setup(
    name='MetaList',
    version='0.1.10',
    author='Thomas Lahore',
    author_email='tom.lahore@gmail.com',
    description='A PKM web app integrated with LLMs',
    long_description=long_description,
    long_description_content_type='text/markdown',
    url='https://github.com/evolvingstuff/MetaList',
    install_requires=read_requirements(),
    classifiers=[
        'Programming Language :: Python :: 3.8',
        'License :: OSI Approved :: MIT License',
        'Operating System :: OS Independent',
    ],
    package_data={
        'metalist': ['static/**/*'],
    },
    entry_points={
        'console_scripts': [
            'metalist=metalist.app:run_app',
        ],
    },
    python_requires='>=3.8',
)